import type { Kernel } from "./registries.ts";
import { referencedTables } from "./db.ts";
import {
  docsToMarkdownFiles,
  docsToStaticSiteFiles,
  generateAppDocs,
} from "./app-docs.ts";
import { generateOpenAPISpec } from "./openapi.ts";
import { detectHandlerAbi, type HandlerAbi } from "./handler-abi.ts";
import {
  CONTEXT_SHIM_PATH,
  generateContextShimRuntimeSource,
} from "./export-context-shim.ts";
import { generateRouterRuntimeSource, ROUTER_PATH } from "./export-router.ts";
import {
  generateValidationRuntimeSource,
  VALIDATION_PATH,
} from "./export-validation.ts";
import {
  type GeneratedValidators,
  generateValidatorsRuntimeSource,
  type SkippedSchema,
  VALIDATORS_PATH,
} from "./export-validators.ts";
import { compareRouteKeys, compareStrings } from "./route-order.ts";
import { ENTITY_SCOPE_NAMES } from "./reserved-names.ts";
import {
  APP_AUTH_GATE_CONFIG,
  CORS_ALLOW_METHODS,
  PROJECT_GITIGNORE,
  ROUTE_METHOD_NOT_ALLOWED_CODE,
  ROUTE_NOT_FOUND_CODE,
} from "./config.ts";
import {
  type AppPackageEmission,
  assertRuntimeDependencyPins,
  DENO_RUNTIME_PGLITE_SPECIFIER,
  planAppPackageEmission,
} from "./runtime-dependencies.ts";
import {
  BUILTIN_AUDIT_CATEGORIES,
  type MigrationEntry,
  type RouteEntry,
  type SchemaEntry,
  type TemplateEntry,
} from "./types.ts";

// Default project identity embedded into an export when the caller supplies no
// projectName/projectVersion. Exported so the production-build smoke gate can
// assert the generated /_health contract ({ ok, name, version }) against the same
// defaults the generator emits, rather than re-declaring the literals.
export const DEFAULT_APP_NAME = "OpenTide App";
export const DEFAULT_APP_VERSION = "unversioned";

// --- Deterministic emission ordering ---
//
// Every exported collection is emitted in a canonical order so the same kernel
// state always produces byte-identical output. Registries hand entries back in
// insertion order (Map iteration); sorting here — in the export path, not in the
// registries — keeps determinism a property of the export without changing the
// live runtime's registration order. See docs/production-output-contract.md.

function byModuleName(
  a: { module?: string; name: string },
  b: { module?: string; name: string },
): number {
  return compareStrings(a.module ?? "", b.module ?? "") ||
    compareStrings(a.name, b.name);
}

// The canonical route order now lives in core/route-order.ts, because the live preview
// resolves in it too. Aliased rather than renamed at ~10 call sites.
const byRouteKey = compareRouteKeys;

function byKey(a: { key: string }, b: { key: string }): number {
  return compareStrings(a.key, b.key);
}

interface OrderedSchemaPlan {
  schema: SchemaEntry;
  baseSql: string;
  postBaseSql: string[];
}

interface ExportedMigration {
  id: string;
  path: string;
  tableName: string;
  version: number;
  sha256: string;
}

interface MigrationManifest {
  formatVersion: number;
  projectVersion: string;
  migrations: ExportedMigration[];
}

const MIGRATION_MANIFEST_PATH = "migrations/manifest.json";
const REFERENCE_SEED_MANIFEST_PATH = "seeds/reference/manifest.json";

function splitSchemaStatements(sql: string): string[] {
  return sql.split(";").map((stmt) => stmt.trim()).filter(Boolean);
}

function isCreateTableStatement(sql: string): boolean {
  return /^\s*CREATE\s+TABLE\b/i.test(sql);
}

function schemaPlan(schema: SchemaEntry): OrderedSchemaPlan {
  const statements = splitSchemaStatements(schema.sql);
  const baseIndex = statements.findLastIndex(isCreateTableStatement);
  return {
    schema,
    baseSql: baseIndex === -1
      ? schema.sql.trim().replace(/;\s*$/, "")
      : statements[baseIndex]!,
    postBaseSql: baseIndex === -1 ? [] : statements.slice(baseIndex + 1),
  };
}

function orderSchemaPlansForExport(
  schemas: SchemaEntry[],
): OrderedSchemaPlan[] {
  const plans = schemas.map(schemaPlan).sort((a, b) =>
    compareStrings(a.schema.tableName, b.schema.tableName)
  );
  const byTable = new Map(plans.map((plan) => [plan.schema.tableName, plan]));
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const plan of plans) {
    dependents.set(plan.schema.tableName, new Set());
    indegree.set(plan.schema.tableName, 0);
  }

  for (const plan of plans) {
    const tableName = plan.schema.tableName;
    for (const dep of referencedTables(plan.baseSql)) {
      if (dep === tableName || !byTable.has(dep)) continue;
      dependents.get(dep)!.add(tableName);
      indegree.set(tableName, (indegree.get(tableName) ?? 0) + 1);
    }
  }

  const ready = plans
    .map((plan) => plan.schema.tableName)
    .filter((tableName) => indegree.get(tableName) === 0);
  const ordered: OrderedSchemaPlan[] = [];

  while (ready.length > 0) {
    ready.sort(compareStrings);
    const tableName = ready.shift()!;
    ordered.push(byTable.get(tableName)!);

    for (
      const dependent of [...dependents.get(tableName)!].sort(compareStrings)
    ) {
      indegree.set(dependent, indegree.get(dependent)! - 1);
      if (indegree.get(dependent) === 0) ready.push(dependent);
    }
  }

  if (ordered.length !== plans.length) {
    const unresolved = plans
      .map((plan) => plan.schema.tableName)
      .filter((tableName) =>
        !ordered.some((plan) => plan.schema.tableName === tableName)
      )
      .sort(compareStrings);
    throw new Error(
      `Cannot export schema.sql: cyclic CREATE TABLE foreign-key dependency among ${
        unresolved.join(", ")
      }.`,
    );
  }

  return ordered;
}

function schemaSqlForExport(orderedPlans: OrderedSchemaPlan[]): string {
  const statements = [
    ...orderedPlans.map((plan) => plan.baseSql),
    ...orderedPlans.flatMap((plan) => plan.postBaseSql),
  ];
  return statements.map((stmt) => stmt.replace(/;\s*$/, "") + ";").join("\n\n");
}

function migrationSortKey(migration: MigrationEntry): string {
  const id = String(migration.id).padStart(12, "0");
  const version = String(migration.version).padStart(8, "0");
  return [
    migration.appliedAt,
    id,
    migration.tableName,
    version,
  ].join("\0");
}

function migrationSqlForExport(sql: string): string {
  return sql.trim().replace(/;\s*$/, "") + ";\n";
}

function migrationStableId(migration: MigrationEntry): string {
  return `${migration.tableName}_v${migration.version}`;
}

async function migrationFilesForExport(
  kernel: Kernel,
  schemas: SchemaEntry[],
  projectVersion: string,
): Promise<ExportFile[]> {
  const migrations: MigrationEntry[] = [];
  for (const schema of schemas) {
    const tableMigrations = await kernel.db.listMigrations(schema.tableName);
    migrations.push(
      ...tableMigrations.filter((migration) => migration.rolledBackAt === null),
    );
  }
  migrations.sort((a, b) =>
    compareStrings(migrationSortKey(a), migrationSortKey(b))
  );

  const files: ExportFile[] = [];
  const manifestEntries: ExportedMigration[] = [];
  for (const migration of migrations) {
    const id = migrationStableId(migration);
    const path = `migrations/${id}.sql`;
    const content = migrationSqlForExport(migration.sql);
    manifestEntries.push({
      id,
      path,
      tableName: migration.tableName,
      version: migration.version,
      sha256: await sha256Hex(new TextEncoder().encode(content)),
    });
    files.push({ path, content });
  }

  const manifest: MigrationManifest = {
    formatVersion: 1,
    projectVersion,
    migrations: manifestEntries,
  };
  files.push({
    path: MIGRATION_MANIFEST_PATH,
    content: JSON.stringify(manifest, null, 2) + "\n",
  });
  return files;
}

function referenceSeedManifestForExport(projectVersion: string): ExportFile {
  return {
    path: REFERENCE_SEED_MANIFEST_PATH,
    content: JSON.stringify(
      {
        formatVersion: 1,
        projectVersion,
        seeds: [],
      },
      null,
      2,
    ) + "\n",
  };
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function serialColumnsForSchema(sql: string): string[] {
  const columns = new Set<string>();
  const pattern =
    /(?:^|[(,])\s*"?(?<name>[A-Za-z_][A-Za-z0-9_]*)"?\s+(?:SMALLSERIAL|SERIAL|BIGSERIAL)\b/gi;
  for (const match of sql.matchAll(pattern)) {
    const name = match.groups?.name;
    if (name) columns.add(name);
  }
  return [...columns].sort(compareStrings);
}

function seedSequenceResetSql(tableName: string, columnName: string): string {
  const quotedTable = quoteIdentifier(tableName);
  const quotedColumn = quoteIdentifier(columnName);
  return [
    "SELECT setval(",
    `  pg_get_serial_sequence(${sqlLiteral(quotedTable)}, ${
      sqlLiteral(columnName)
    }),`,
    `  COALESCE((SELECT MAX(${quotedColumn}) FROM ${quotedTable}), 1),`,
    `  (SELECT COUNT(*) FROM ${quotedTable}) > 0`,
    ");",
  ].join("\n");
}

// Reproducible tar mtime. Honors SOURCE_DATE_EPOCH (the reproducible-builds.org
// convention) when set to a valid non-negative integer; otherwise a fixed epoch
// so archives never embed wall-clock build time.
const SOURCE_DATE_EPOCH_ENV = "SOURCE_DATE_EPOCH";
const DEFAULT_SOURCE_EPOCH = 0;

function deterministicMtime(): number {
  const raw = readSourceDateEpoch();
  if (raw === undefined) return DEFAULT_SOURCE_EPOCH;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_SOURCE_EPOCH;
}

function readSourceDateEpoch(): string | undefined {
  const env =
    (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } })
      .Deno?.env;
  try {
    return env?.get(SOURCE_DATE_EPOCH_ENV) ?? undefined;
  } catch {
    // No --allow-env in this process: fall back to the fixed epoch.
    return undefined;
  }
}

// SHA-256 over raw bytes, hex-encoded. Shared by the export manifest and the
// determinism/manifest tests so both hash artifacts exactly the same way.
export async function sha256Hex(data: Uint8Array): Promise<string> {
  // Copy into a fresh (non-shared) ArrayBuffer so the byte view satisfies the
  // strict BufferSource type expected by crypto.subtle.digest.
  const copy = new Uint8Array(data.length);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The on-the-wire bytes of an exported file: raw for binary assets, UTF-8 for
// text. This is what gets hashed, tarred, and zipped.
export function fileBytes(file: ExportFile): Uint8Array {
  return file.binary ?? new TextEncoder().encode(file.content ?? "");
}

// The manifest's sourceFingerprint formula, factored out so the generator
// (generateManifest) and the verifier (verification/production-manifest.ts)
// share ONE definition and can never drift: a single SHA-256 over the
// path-sorted [path, sha256(content)] pairs. The manifest itself is never among
// the inputs. Sorting here makes the result independent of the caller's order.
export function computeSourceFingerprint(
  entries: ReadonlyArray<{ path: string; sha256: string }>,
): Promise<string> {
  const pairs = [...entries]
    .sort((a, b) => compareStrings(a.path, b.path))
    .map((e) => [e.path, e.sha256]);
  return sha256Hex(new TextEncoder().encode(JSON.stringify(pairs)));
}

export async function generateReadme(
  kernel: Kernel,
  projectName?: string,
  opts?: Pick<ExportProjectOptions, "includeSeedData" | "projectVersion">,
  skippedSchemas: readonly SkippedSchema[] = [],
): Promise<string> {
  const name = projectName ?? "OpenTide App";
  const customInstructions = kernel.configs.get("_genie_custom_instructions") as
    | string
    | null;
  const lines: string[] = [`# ${name}`, ""];

  if (customInstructions) {
    lines.push(customInstructions, "");
  }

  const routes = [...kernel.routes.list()].sort(byRouteKey);
  if (routes.length > 0) {
    lines.push("## API Endpoints", "");
    lines.push("| Method | Path | Handler |");
    lines.push("|--------|------|---------|");
    for (const r of routes) {
      const summary = r.schema?.summary ? ` — ${r.schema.summary}` : "";
      lines.push(`| ${r.method} | ${r.path} | ${r.handlerName}${summary} |`);
    }
    lines.push("");
  }

  // Only when there is something to say, so an export with nothing wrong stays
  // byte-identical to what it produced before. A route whose schema ajv refused serves
  // unvalidated in BOTH hosts — that is deliberate, one bad schema must not take the app
  // down — but shipping it without saying so leaves the reader believing their app
  // validates when it does not, and the kernel-side warning is a log line in a panel they
  // may never have opened.
  if (skippedSchemas.length > 0) {
    lines.push("## Routes shipping without validation", "");
    lines.push(
      "These schemas could not be compiled, so the requests below are **not** checked",
      "against them. The route still works; nothing rejects a malformed request.",
      "",
    );
    lines.push("| Route | Part | Why |");
    lines.push("|-------|------|-----|");
    for (const sk of skippedSchemas) {
      lines.push(
        `| ${sk.route} | ${sk.slot} | ${sk.reason.replace(/\|/g, "\\|")} |`,
      );
    }
    lines.push("");
  }

  const schemas = await kernel.db.listSchemas();
  if (schemas.length > 0) {
    lines.push("## Database Tables", "");
    for (const s of schemas) {
      lines.push(`- \`${s.tableName}\``);
    }
    lines.push("");
  }

  const envVars = kernel.envVars.list();
  const secrets = [...kernel.secrets.list()].sort(byKey);
  if (envVars.length > 0 || secrets.length > 0) {
    lines.push("## Environment Variables", "");
    for (const v of envVars) {
      lines.push(`- \`${v.key}\`${v.description ? ` — ${v.description}` : ""}`);
    }
    for (const s of secrets) {
      lines.push(
        `- \`${s.key}\`${
          s.description ? ` — ${s.description}` : ""
        } *(secret)*`,
      );
    }
    lines.push("");
  }

  const configList = runtimeConfigEntries(kernel);
  if (configList.length > 0) {
    lines.push("## Configuration", "");
    lines.push(
      "Configuration values are embedded into the exported app at build time and read with `config.get(name)`.",
      "",
    );
    for (const c of configList) {
      const entry = kernel.configs.getEntry(c.name);
      const val = JSON.stringify(c.value);
      lines.push(
        `- \`${c.name}\` = \`${val}\`${
          entry?.description ? ` — ${entry.description}` : ""
        }`,
      );
    }
    lines.push("");
  }

  if (envVars.length > 0 || secrets.length > 0) {
    lines.push(
      "Runtime environment values are read from process environment first, then `.env` if present.",
      "",
    );
  }

  if (schemas.length > 0) {
    lines.push("## Data Export", "");
    lines.push(
      "Production exports can include `migrations/manifest.json` and ordered SQL files under `migrations/`. Deployed databases track applied migrations in `_genie_app_migrations`.",
    );
    lines.push(
      opts?.includeSeedData
        ? "This export includes `seed.sql`. Captured local rows are applied only when initializing a fresh database."
        : "This export includes schema only. Current database rows are not included unless seed export is enabled.",
    );
    lines.push(
      "Run `db:prepare` during deploy to initialize a fresh database or apply pending migrations before starting the app.",
    );
    lines.push("");
  }

  lines.push(...gettingStartedLines("deno"));
  lines.push("Server configuration:", "");
  lines.push("- `--port <number|auto>` or `PORT` selects the HTTP port.");
  lines.push("- `--host <host>` or `HOST` selects the bind host.");
  lines.push(
    "- If no port is configured and the default port is busy, the app tries random available ports.",
  );
  lines.push(
    "- `GET /_health` returns a health response with app name and version.",
  );
  lines.push(
    "- `GET /openapi.json` serves the exported OpenAPI spec when present.",
    "",
  );

  return lines.join("\n");
}

const GETTING_STARTED_HEADING = "## Getting Started";
const SERVER_CONFIG_HEADING = "Server configuration:";

// How to run the exported app, per target. Node exports carry no compiled
// binary, so they skip that block.
function gettingStartedLines(target: "deno" | "node"): string[] {
  const commands = target === "node"
    ? [
      "npm install",
      "npm run db:prepare",
      "npm run db:check",
      "npm start",
      "npm start -- --help",
      "npm start -- --port 8080",
      "PORT=8080 npm start",
    ]
    : [
      "deno task start",
      "deno task db:prepare",
      "deno task db:check",
      "deno task start -- --help",
      "deno task start -- --port 8080",
      "PORT=8080 deno task start",
    ];
  const lines = [
    GETTING_STARTED_HEADING,
    "",
    "```bash",
    ...commands,
    "```",
    "",
  ];
  if (target === "deno") {
    lines.push(
      "Compiled binaries accept the same runtime flags:",
      "",
      "```bash",
      "./app --help",
      "./app --prepare-db",
      "./app --check-db",
      "./app --port 8080",
      "./app --random-port",
      "```",
      "",
    );
  }
  return lines;
}

// The exported README with its Getting Started section rewritten for the Node
// build (npm, not deno task). Anything else in it is target-neutral.
export function readmeForNode(readme: string): string {
  const start = readme.indexOf(GETTING_STARTED_HEADING);
  const end = readme.indexOf(SERVER_CONFIG_HEADING);
  if (start < 0 || end < start) return readme;
  return readme.slice(0, start) +
    gettingStartedLines("node").join("\n") + "\n" + readme.slice(end);
}

export async function generateAgentMd(
  kernel: Kernel,
  projectName?: string,
  opts?: Pick<ExportProjectOptions, "includeSeedData">,
): Promise<string> {
  const name = projectName ?? "OpenTide App";
  const customInstructions = kernel.configs.get("_genie_custom_instructions") as
    | string
    | null;
  const lines: string[] = [`# ${name}`, ""];

  if (customInstructions) {
    lines.push("## Project Instructions", "");
    lines.push(customInstructions, "");
  }

  lines.push("## Application Source of Truth", "");
  lines.push(
    "This app's editable source lives in the exported files and the Tide/Genie registries that generated them: routes, handlers, functions, templates, assets, types, configs, and schemas.",
  );
  lines.push(
    "Do not treat internal database tables or generated build artifacts as source files. Tables whose names start with `_` are implementation details; `_temp_build` and temporary export/typecheck tables are not where the app's JavaScript lives.",
  );
  lines.push("");

  const modules = kernel.listModules();
  if (modules.length > 0) {
    lines.push("## Modules", "");
    for (const mod of modules) {
      lines.push(`- \`${mod}\``);
    }
    lines.push("");
  }

  const routes = [...kernel.routes.list()].sort(byRouteKey);
  if (routes.length > 0) {
    lines.push("## Routes", "");
    for (const r of routes) {
      lines.push(
        `- \`${r.method} ${r.path}\` → \`${r.handlerName}\`${
          r.module ? ` (${r.module})` : ""
        }`,
      );
    }
    lines.push("");
  }

  const handlers = [...kernel.handlers.list()].sort(byModuleName);
  if (handlers.length > 0) {
    lines.push("## Handlers", "");
    for (const h of handlers) {
      lines.push(
        `- \`${h.name}\`${h.module ? ` (${h.module})` : ""}${
          h.purpose ? ` — ${h.purpose}` : ""
        }`,
      );
    }
    lines.push("");
  }

  const functions = [...kernel.functions.list()].sort(byModuleName);
  if (functions.length > 0) {
    lines.push("## Functions", "");
    for (const f of functions) {
      lines.push(
        `- \`${f.name}\`${f.module ? ` (${f.module})` : ""}${
          f.purpose ? ` — ${f.purpose}` : ""
        }`,
      );
    }
    lines.push("");
  }

  const schemas = await kernel.db.listSchemas();
  if (schemas.length > 0) {
    lines.push("## Database Schema", "");
    for (const s of schemas) {
      lines.push("```sql");
      lines.push(s.sql + ";");
      lines.push("```", "");
    }
  }

  const configList = kernel.configs.list()
    .filter((c) => c.name !== "_genie_custom_instructions")
    .sort(byModuleName);
  if (configList.length > 0) {
    lines.push("## Configuration", "");
    for (const c of configList) {
      const entry = kernel.configs.getEntry(c.name);
      const val = entry ? JSON.stringify(entry.value) : c.type;
      lines.push(
        `- \`${c.name}\` = \`${val}\`${
          c.description ? ` — ${c.description}` : ""
        }`,
      );
    }
    lines.push("");
  }

  lines.push("## Runtime Notes", "");
  const runtimeNotes = kernel.runtime.exportRuntimeNotes?.(kernel, opts) ?? [
    "App configs are embedded into the export at build time.",
    "Environment variables and secrets are read from process environment first, then `.env` if present.",
  ];
  for (const note of runtimeNotes) {
    lines.push(`- ${note}`);
  }
  lines.push("");

  return lines.join("\n");
}

export interface ExportProjectOptions {
  includeEnvFile?: boolean;
  includeSeedData?: boolean;
  includeMigrations?: boolean;
  includeReferenceSeeds?: boolean;
  includeReadme?: boolean;
  includeAgent?: boolean;
  includeGitignore?: boolean;
  includeDocsMarkdown?: boolean;
  includeDocsSite?: boolean;
  // Emit a self-describing manifest.json (see generateManifest). Off by default
  // so dev exports and the Phase 1 determinism guarantees stay byte-identical.
  includeManifest?: boolean;
  // The committed deno.lock's bytes, shipped verbatim as an ExportFile
  // (Milestone 6, Slice 6.1). Passed IN (sourced from <projectDir>/deno.lock by
  // the caller) rather than read here, so the export path stays pure and
  // deterministic: identical bytes in → identical bytes out. Undefined for a
  // generated app with no committed lock, in which case no deno.lock is emitted
  // and the dependency_lock gate skips. See verification/production-lock.ts.
  denoLock?: string;
  // The committed package-lock.json's bytes, shipped verbatim as an ExportFile
  // (Milestone 6, Slice 6.2) — the Node counterpart of denoLock. Sourced from
  // <projectDir>/package-lock.json by the caller and passed IN (not read here) so
  // the export path stays pure and deterministic. It rides in the deno-source
  // export purely for FREE manifest/determinism coverage, then flows verbatim into
  // the Node artifact (buildNodeFiles passes non-.ts / non-deno.json files through)
  // where the node_dependency_lock gate validates it offline. Undefined for a
  // generated app with no committed Node lock → no package-lock.json emitted and
  // that gate skips. See verification/production-node-lock.ts.
  packageLock?: string;
  projectName?: string;
  projectVersion?: string;
}

export interface ExportProjectResult {
  files: ExportFile[];
  tarball: Uint8Array;
  /** Route schemas ajv refused to compile, and which therefore ship unvalidated. The
   * live preview degrades the same way (core/app-server.ts logs a warning and serves the
   * route), but a build that says nothing about it leaves the user believing their app
   * validates when it does not. Empty on almost every export. */
  skippedSchemas: SkippedSchema[];
}

// --- Route path preconditions ---
//
// The kernel path DSL is Hono's: `:name`, an optional brace-delimited regex
// constraint (`:id{[0-9]+}`), and `*`. Brace scanning is BALANCED, not a lazy
// `[^}]*`, because `:id{\d{2}}` is a legal constraint and a lazy scan would read
// the param name of whatever followed the inner brace.
export function routePathParamNames(path: string): string[] {
  const names: string[] = [];
  let i = 0;
  while (i < path.length) {
    const m = /^:(\w+)(\{)?/.exec(path.slice(i));
    if (!m) {
      i++;
      continue;
    }
    names.push(m[1]!);
    i += m[0].length;
    if (!m[2]) continue;
    // Skip the constraint body, counting nested braces.
    let depth = 1;
    while (i < path.length && depth > 0) {
      if (path[i] === "{") depth++;
      else if (path[i] === "}") depth--;
      i++;
    }
  }
  return names;
}

/* A path parameter used twice in one route is data loss, and it is silent.
   `/:id/x/:id` is accepted by the live preview — Hono compiles it and then hands
   `c.req.param()` back exactly ONE `id`, the first segment's, with the second
   discarded. A handler reading `ctx.params.id` for `/A/x/B` sees `"A"` and has no
   way to learn that `"B"` was ever sent.

   Nothing in the field does this (0 of the 172 routes measured across the projects
   on this machine), so the export refuses it rather than carrying the quirk
   forward. It is also a hard precondition for the exported matcher: URLPattern
   rejects a repeated capture-group name at construction time, so a project that
   registered one would otherwise fail at app startup with a pattern-syntax error
   instead of here, with the route named. */
export function assertExportableRoutePaths(
  routes: readonly RouteEntry[],
): void {
  for (const route of routes) {
    const names = routePathParamNames(route.path);
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) repeated.add(name);
      seen.add(name);
    }
    if (repeated.size === 0) continue;
    const listed = [...repeated].map((n) => `":${n}"`).join(", ");
    throw new Error(
      `Cannot export: route ${route.method} ${route.path} uses the path parameter ${listed} more than once. Only the first value survives — every later one is silently discarded — so rename the duplicates (for example ":${
        [...repeated][0]
      }2") and update the handler's ctx.params lookup.`,
    );
  }
}

export async function exportProject(
  kernel: Kernel,
  opts?: ExportProjectOptions,
): Promise<ExportProjectResult> {
  const files: ExportFile[] = [];

  // Sorted here rather than at the point of use so the precondition below reports
  // the same offending route for the same kernel state on every machine.
  const allRoutes = [...kernel.routes.list()].sort(byRouteKey);
  assertExportableRoutePaths(allRoutes);

  const installedPackages = [...(kernel.runtime.listPackages?.(kernel) ?? [])]
    .sort((a, b) => compareStrings(a.name, b.name));
  // A user package may share its name with a dependency the generated shell itself
  // imports (hono, @electric-sql/pglite, @hono/node-server). Before this, the spread
  // below put the user's specifier on the platform's own import-map key and the
  // shell silently ran on the user's version. Now the colliding copy is emitted under
  // an alias while `packages.<name>` keeps the real name. See planAppPackageEmission.
  const packageEmissions = planAppPackageEmission(
    installedPackages.map((p) => p.name),
  );
  const specifierByName = new Map(
    installedPackages.map((p) => [p.name, p.specifier]),
  );
  const packageImports: Record<string, string> = {};
  for (const emission of packageEmissions) {
    packageImports[emission.moduleSpecifier] = specifierByName.get(
      emission.name,
    )!;
  }

  files.push({
    path: "deps.ts",
    content: generateDeps(
      packageEmissions,
      runtimeConfigEntries(kernel),
    ),
  });
  // The route matcher, always emitted: it IS the shell's routing now, and it has no
  // imports of its own, so it is also the one file the differential gate can load
  // without booting the database. See core/export-router.ts.
  files.push({
    path: ROUTER_PATH,
    content: generateRouterRuntimeSource(),
  });
  // Request validation, always emitted for the same two reasons the matcher is: the shell
  // references it unconditionally, and a file with no imports of its own is one a gate can
  // load and drive without booting the database. See core/export-validation.ts.
  files.push({
    path: VALIDATION_PATH,
    content: generateValidationRuntimeSource(),
  });
  // The validator FUNCTIONS, compiled from this kernel's route schemas by ajv. Conditional,
  // like context-shim.ts: an app whose routes declare no schema gets no file and an empty
  // table, and stays byte-identical to what it exported before validation existed.
  const generatedValidators = generateValidatorsRuntimeSource(allRoutes);
  if (generatedValidators.source !== null) {
    files.push({
      path: VALIDATORS_PATH,
      content: generatedValidators.source,
    });
  }
  files.push({ path: "deno.json", content: generateDenoJson(packageImports) });

  // Ship the committed deno.lock verbatim (Slice 6.1) when the caller sourced one
  // from the project. Emitted here — before the sort + manifest — so it is hashed
  // by generateManifest and byte-covered by the determinism gate like any other
  // file. The dependency_lock gate validates it offline; the build never produces
  // it. Absent → no lockfile emitted → the gate skips.
  if (opts?.denoLock !== undefined) {
    files.push({ path: "deno.lock", content: opts.denoLock });
  }

  // Ship the committed package-lock.json verbatim (Slice 6.2) when the caller
  // sourced one from the project. Like deno.lock above, it is emitted before the
  // sort + manifest so generateManifest hashes it and the determinism gate
  // byte-covers it for free; it then flows verbatim into the Node artifact, where
  // the node_dependency_lock gate validates it offline (the build never produces
  // it). Absent → no package-lock.json emitted → that gate skips.
  if (opts?.packageLock !== undefined) {
    files.push({ path: "package-lock.json", content: opts.packageLock });
  }

  const handlerPaths = new Map<string, string>();
  // Which ABI each handler was written against, derived from its source exactly as
  // core/compiler.ts derives it for the live kernel. The route-wiring loop in
  // generateMain needs it, and only this loop has the sources.
  const handlerAbis = new Map<string, HandlerAbi>();
  // Whether anything in the tree needs the emitted legacy-context shim: a handler
  // written against the old ABI needs the wrapper, and any module that names the
  // `Context` type needs the type import wrapModule adds to resolve. Emitted
  // conditionally, like types.ts and seed.sql, so a project written entirely against
  // the fetch ABI — the only shape the agent produces now — ships without it.
  let needsContextShim = false;
  for (const h of [...kernel.handlers.list()].sort(byModuleName)) {
    const dir = h.module ? `${h.module}/handlers` : "handlers";
    const filePath = `${dir}/${h.name}.ts`;
    handlerPaths.set(h.name, filePath);
    const abi = detectHandlerAbi(h.source, h.name);
    handlerAbis.set(h.name, abi);
    if (
      abi === "legacy-context" || sourceReferencesLegacyContextType(h.source)
    ) {
      needsContextShim = true;
    }
    files.push({
      path: filePath,
      content: wrapModule(h.source, h.name, h.module ? 2 : 1),
    });
  }

  const functionPaths = new Map<string, string>();
  for (const f of [...kernel.functions.list()].sort(byModuleName)) {
    const dir = f.module ? `${f.module}/functions` : "functions";
    const filePath = `${dir}/${f.name}.ts`;
    functionPaths.set(f.name, filePath);
    if (sourceReferencesLegacyContextType(f.source)) needsContextShim = true;
    files.push({
      path: filePath,
      content: wrapModule(f.source, f.name, f.module ? 2 : 1),
    });
  }

  if (needsContextShim) {
    files.push({
      path: CONTEXT_SHIM_PATH,
      content: generateContextShimRuntimeSource(),
    });
  }

  const templates = [...kernel.templates.list()].sort(byModuleName);
  for (const t of templates) {
    const dir = t.module ? `${t.module}/templates` : "templates";
    files.push({ path: `${dir}/${t.name}.html`, content: t.content });
  }

  const assets = [...kernel.assets.list()].sort(byModuleName);
  for (const a of assets) {
    const entry = kernel.assets.get(a.name);
    if (entry) {
      const dir = a.module ? `${a.module}/assets` : "assets";
      files.push({ path: `${dir}/${a.name}`, binary: entry.content });
    }
  }

  const typesList = [...kernel.types.list()].sort(byModuleName);
  if (typesList.length > 0) {
    const typesDefs = typesList.map((t) => {
      const fields = t.fields.map((f) => {
        const opt = f.optional ? "?" : "";
        return `  ${f.name}${opt}: ${f.type};${
          f.description ? ` // ${f.description}` : ""
        }`;
      }).join("\n");
      const desc = t.description ? `/** ${t.description} */\n` : "";
      return `${desc}export interface ${t.name} {\n${fields}\n}`;
    }).join("\n\n");
    files.push({ path: "types.ts", content: typesDefs + "\n" });
  }

  const schemas = await kernel.db.listSchemas();
  const orderedSchemaPlans = orderSchemaPlansForExport(schemas);
  if (schemas.length > 0) {
    files.push({
      path: "schema.sql",
      content: schemaSqlForExport(orderedSchemaPlans),
    });

    if (opts?.includeMigrations) {
      files.push(
        ...await migrationFilesForExport(
          kernel,
          schemas,
          opts.projectVersion ?? DEFAULT_APP_VERSION,
        ),
      );
    }

    if (opts?.includeSeedData) {
      const seedLines: string[] = [];
      for (const { schema } of orderedSchemaPlans) {
        const rows = await kernel.db.query(
          `SELECT * FROM "${schema.tableName}"`,
        );
        for (const row of rows) {
          const cols = Object.keys(row);
          const vals = cols.map((c) => sqlLiteral(row[c]));
          seedLines.push(
            `INSERT INTO "${schema.tableName}" (${
              cols.map((c) => `"${c}"`).join(", ")
            }) VALUES (${vals.join(", ")});`,
          );
        }
        if (rows.length > 0) {
          for (const column of serialColumnsForSchema(schema.sql)) {
            seedLines.push(seedSequenceResetSql(schema.tableName, column));
          }
        }
      }
      if (seedLines.length > 0) {
        files.push({ path: "seed.sql", content: seedLines.join("\n") });
      }
    }
  }

  if (opts?.includeReferenceSeeds) {
    files.push(
      referenceSeedManifestForExport(
        opts.projectVersion ?? DEFAULT_APP_VERSION,
      ),
    );
  }

  // envVars.list() is already key-sorted; sort secrets and the raw .env keys so
  // every env-derived file emits in a stable, machine-independent order.
  const envVarsList = kernel.envVars.list();
  const dotEnvVars = kernel.env.all();
  const secretsList = [...kernel.secrets.list()].sort(byKey);
  const dotEnvKeys = Object.keys(dotEnvVars).sort(compareStrings);

  const allEnvKeys = new Set<string>();
  for (const v of envVarsList) allEnvKeys.add(v.key);
  for (const key of dotEnvKeys) allEnvKeys.add(key);
  for (const s of secretsList) allEnvKeys.add(s.key);

  if (allEnvKeys.size > 0) {
    const exampleLines: string[] = [];
    for (const v of envVarsList) {
      const comment = v.description ? `# ${v.description}\n` : "";
      exampleLines.push(`${comment}${v.key}=`);
    }
    for (const s of secretsList) {
      const comment = s.description ? `# ${s.description}\n` : "";
      exampleLines.push(`${comment}${s.key}=`);
    }
    for (const key of dotEnvKeys) {
      if (
        !envVarsList.some((v) => v.key === key) &&
        !secretsList.some((s) => s.key === key)
      ) {
        exampleLines.push(`${key}=`);
      }
    }
    files.push({
      path: ".env.example",
      content: exampleLines.join("\n") + "\n",
    });

    if (opts?.includeEnvFile) {
      const envLines: string[] = [];
      for (const v of envVarsList) {
        const resolved = kernel.envVars.resolve(v.key);
        envLines.push(formatEnvLine(v.key, resolved ?? ""));
      }
      for (const s of secretsList) {
        const resolved = kernel.secrets.resolve(s.key);
        envLines.push(formatEnvLine(s.key, resolved ?? ""));
      }
      for (const key of dotEnvKeys) {
        if (
          !envVarsList.some((v) => v.key === key) &&
          !secretsList.some((s) => s.key === key)
        ) {
          envLines.push(formatEnvLine(key, dotEnvVars[key] ?? ""));
        }
      }
      files.push({ path: ".env", content: envLines.join("\n") + "\n" });
    }
  }

  if (allRoutes.some((r) => r.schema)) {
    const spec = generateOpenAPISpec(allRoutes, { title: DEFAULT_APP_NAME });
    files.push({
      path: "openapi.json",
      content: JSON.stringify(spec, null, 2) + "\n",
    });
  }

  const auditReport = generateAuditReport(kernel);
  if (auditReport) {
    files.push({ path: "AUDIT-REPORT.md", content: auditReport });
  }

  if (opts?.includeGitignore) {
    files.push({ path: ".gitignore", content: generateGitignore() });
  }

  if (opts?.includeReadme !== false) {
    files.push({
      path: "README.md",
      content: await generateReadme(
        kernel,
        opts?.projectName,
        opts,
        generatedValidators.skipped,
      ),
    });
  }
  if (opts?.includeAgent !== false) {
    files.push({
      path: "AGENT.md",
      content: await generateAgentMd(kernel, opts?.projectName, opts),
    });
  }

  if (opts?.includeDocsMarkdown || opts?.includeDocsSite) {
    const docs = await generateAppDocs(kernel);
    if (opts.includeDocsMarkdown) {
      files.push(...docsToMarkdownFiles(docs));
    }
    if (opts.includeDocsSite) {
      files.push(
        ...docsToStaticSiteFiles(docs, opts.projectName ?? DEFAULT_APP_NAME)
          .map((
            file,
          ) => ({
            ...file,
            path: `docs/${file.path}`,
          })),
      );
    }
  }

  // The auth gate (core/config.ts APP_AUTH_GATE_CONFIG), baked in here. The preview
  // answers a missing gate handler with a 500 per request; an export would ship that,
  // so it refuses instead.
  const gateConfig = kernel.configs.get(APP_AUTH_GATE_CONFIG);
  const authGate = typeof gateConfig === "string" && gateConfig !== ""
    ? gateConfig
    : null;
  if (authGate !== null && !handlerPaths.has(authGate)) {
    throw new Error(
      `Cannot export: ${APP_AUTH_GATE_CONFIG} names handler "${authGate}", which does not exist. Define it, or delete the config to export with no gate.`,
    );
  }

  files.push({
    path: "main.ts",
    content: generateMain(
      { routes: allRoutes, templates, assets, authGate },
      handlerPaths,
      functionPaths,
      handlerAbis,
      generatedValidators,
      opts,
    ),
  });

  // Canonical file order: the exported list (and every archive built from it) is
  // sorted by path so the same kernel state yields an identical manifest.
  files.sort((a, b) => compareStrings(a.path, b.path));

  // The manifest describes every other file, so it is generated last — over the
  // already-canonical set — then the list is re-sorted so it lands in path order
  // like everything else. Self-exclusion holds because it is hashed before it is
  // pushed. Off by default; existing exports stay byte-identical.
  if (opts?.includeManifest) {
    files.push(await generateManifest(files, kernel, opts));
    files.sort((a, b) => compareStrings(a.path, b.path));
  }

  return {
    files,
    tarball: createTarball(files),
    skippedSchemas: generatedValidators.skipped,
  };
}

export const MANIFEST_PATH = "manifest.json";

// Bump only on a breaking change to the manifest shape. Consumers key off this.
export const MANIFEST_FORMAT_VERSION = 1;

const BINARY_RUNTIME_ROOT_FILES = new Set([
  "schema.sql",
  "seed.sql",
  "openapi.json",
]);

/* Every file the generated main.ts reads off disk at runtime, and therefore
   every file a compiled binary has to embed with `deno compile --include`.
   A path missing from here does not break the build. It breaks later, in a
   browser, as a 404 on /_assets, or as a migration that cannot be read.

   THIS IS THE ONE DEFINITION, and it lives in export.ts rather than build.ts so
   that generateManifest can record it. An export states its own runtime include
   list in manifest.json now, which means a build driver outside this repo reads
   the list instead of keeping a second copy of this rule.

   That is not hypothetical. Speed Read compiles through its own bash script — it
   needs --env-file and build provenance stamping this repo has no notion of —
   and that script carried a hand-written array of five module asset directories.
   Two modules gained assets, nobody extended the array, and four stylesheets and
   scripts reached production absent from the binary and stayed there for two
   releases, with the pages returning 200 and rendering unstyled. The same shape
   had already bitten over the permission list, which is why
   APP_RUNTIME_PERMISSIONS is one constant. This is the other half of that fix.

   Generated docs are excluded deliberately. `docs/` is a prefix this exporter
   owns and writes into (docsToMarkdownFiles, docsToStaticSiteFiles); nothing
   under it is read at runtime, and `docs/assets/*.md` — the generated reference
   page for each registered asset — otherwise matches the "/assets/" test and
   gets embedded in every binary for no reason. */
export function binaryRuntimeIncludePaths(files: ExportFile[]): string[] {
  const includes = files
    .map((file) => file.path)
    .filter((path) => !path.startsWith("docs/"))
    .filter((path) =>
      BINARY_RUNTIME_ROOT_FILES.has(path) || path.startsWith("migrations/") ||
      path.startsWith("seeds/reference/") || path.includes("/assets/") ||
      path.startsWith("assets/")
    );
  return [...new Set(includes)].sort();
}

export interface ManifestFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

// The parsed shape of manifest.json. Exported so the verification layer can type
// a manifest it reads back off an export without re-declaring the contract.
export interface ExportManifest {
  formatVersion: number;
  projectName: string;
  projectVersion: string;
  runtimeId: string;
  exportOptions: Record<string, boolean>;
  files: ManifestFileEntry[];
  dataArtifacts: {
    migrations: string[];
    referenceSeeds: string[];
  };
  /* The files a compiled binary must embed, from binaryRuntimeIncludePaths.
     Recorded so an out-of-tree build driver can read the list rather than
     reimplement the rule and let its copy go stale — see that function. */
  runtimeIncludePaths: string[];
  /* The permission flags an exported app runs with, from
     APP_RUNTIME_PERMISSIONS — the same set the generated `deno task start`
     grants and `binaryCompileArgs` compiles with.

     Recorded for the same reason as runtimeIncludePaths, and it is the older
     of the two problems: the permission set had three hand-maintained copies
     before the constant, and there is still a fourth outside this repo, in
     Speed Read's bash compile script. A binary granted less than
     `deno task start` does not fail at build. It fails at runtime, in
     production, doing something the app has always done. */
  runtimePermissions: string[];
  sourceFingerprint: string;
  checks: unknown[];
  artifacts: unknown[];
}

// Resolve every boolean export toggle to its effective value (README/AGENT
// default on, the rest off) so the manifest records what actually happened, not
// the sparse options object the caller passed.
function resolveExportOptions(
  opts: ExportProjectOptions | undefined,
): Record<string, boolean> {
  return {
    includeEnvFile: opts?.includeEnvFile === true,
    includeSeedData: opts?.includeSeedData === true,
    includeMigrations: opts?.includeMigrations === true,
    includeReferenceSeeds: opts?.includeReferenceSeeds === true,
    includeReadme: opts?.includeReadme !== false,
    includeAgent: opts?.includeAgent !== false,
    includeGitignore: opts?.includeGitignore === true,
    includeDocsMarkdown: opts?.includeDocsMarkdown === true,
    includeDocsSite: opts?.includeDocsSite === true,
    includeManifest: opts?.includeManifest === true,
  };
}

// Build manifest.json describing the export. `files` must be the final emitted
// set MINUS the manifest itself (the manifest never lists or fingerprints
// itself). No volatile data (wall-clock time, local paths, random ids) enters
// the manifest — it is a pure function of canonical app state, so the same state
// yields byte-identical manifests. See docs/production-output-contract.md.
async function generateManifest(
  files: ExportFile[],
  kernel: Kernel,
  opts: ExportProjectOptions | undefined,
): Promise<ExportFile> {
  const entries: ManifestFileEntry[] = [];
  for (const file of files) {
    const bytes = fileBytes(file);
    entries.push({
      path: file.path,
      sha256: await sha256Hex(bytes),
      bytes: bytes.byteLength,
    });
  }
  entries.sort((a, b) => compareStrings(a.path, b.path));

  // A single hash over the path-sorted [path, contentHash] pairs. Two exports
  // with the same sourceFingerprint have an identical source file set. Shared
  // with the verifier via computeSourceFingerprint — one formula, no drift.
  const sourceFingerprint = await computeSourceFingerprint(entries);

  const manifest: ExportManifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    projectName: opts?.projectName ?? DEFAULT_APP_NAME,
    projectVersion: opts?.projectVersion ?? DEFAULT_APP_VERSION,
    runtimeId: kernel.runtimeId,
    exportOptions: resolveExportOptions(opts),
    files: entries,
    dataArtifacts: {
      migrations: entries
        .map((entry) => entry.path)
        .filter((path) =>
          path === MIGRATION_MANIFEST_PATH ||
          (path.startsWith("migrations/") && path.endsWith(".sql"))
        ),
      referenceSeeds: entries
        .map((entry) => entry.path)
        .filter((path) => path.startsWith("seeds/reference/")),
    },
    /* Computed from `files`, which is the emitted set minus the manifest — so
       this can never name a file the export does not carry. */
    runtimeIncludePaths: binaryRuntimeIncludePaths(files),
    runtimePermissions: [...APP_RUNTIME_PERMISSIONS],
    sourceFingerprint,
    // Present-but-empty; populated by later milestones (production pipeline +
    // ledger). Kept in the shape now so the format version is stable.
    checks: [] as unknown[],
    artifacts: [] as unknown[],
  };

  return {
    path: MANIFEST_PATH,
    content: JSON.stringify(manifest, null, 2) + "\n",
  };
}

export interface ExportFile {
  path: string;
  content?: string;
  binary?: Uint8Array;
}

function runtimeConfigEntries(
  kernel: Kernel,
): Array<{ name: string; value: unknown }> {
  return kernel.configs.serialize()
    .filter((c) => !c.name.startsWith("_genie_"))
    .map(({ name, value }) => ({ name, value }))
    .sort((a, b) => compareStrings(a.name, b.name));
}

function jsLiteral(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? "undefined" : json;
}

function formatEnvLine(key: string, value: string): string {
  if (value.includes("\n") || value.includes('"') || value.includes(" ")) {
    return `${key}="${
      value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
    }"`;
  }
  return `${key}=${value}`;
}

function generateDeps(
  // The emission plan, not bare names: a package that collides with one of the
  // shell's own dependencies is imported from its ALIAS, while the `packages` key and
  // the local identifier both stay derived from the REAL name so handler code
  // (`packages.hono`) is untouched.
  emissions: readonly AppPackageEmission[],
  configs: Array<{ name: string; value: unknown }>,
): string {
  const packageImports = emissions.map((e) =>
    `import * as ${sanitizeIdentifier(e.name)} from "${e.moduleSpecifier}";`
  ).join("\n");
  const packageEntries = emissions.map((e) =>
    `  "${e.name}": ${sanitizeIdentifier(e.name)},`
  ).join("\n");
  const packagesExport = emissions.length > 0
    ? `\n${packageImports}\n\nexport const packages: Record<string, unknown> = {\n${packageEntries}\n};\n`
    : `\nexport const packages: Record<string, unknown> = {};\n`;
  const configEntries = configs
    .map((c) => `  [${jsLiteral(c.name)}, ${jsLiteral(c.value)}],`)
    .join("\n");
  const configInitializer = configs.length > 0 ? `[\n${configEntries}\n]` : "";

  return `import { PGlite } from "@electric-sql/pglite";
import { existsSync, readFileSync } from "node:fs";

const pg = new PGlite("./data");
await pg.waitReady;

export const db = {
  async query(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const result = await pg.query(sql, params);
    return result.rows as Record<string, unknown>[];
  },
  async execute(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    const result = await pg.query(sql, params);
    return { changes: result.affectedRows ?? 0 };
  },
  // PGlite is Postgres running in this process: exiting without this leaves the data
  // directory with an unflushed WAL, which the next start has to replay. Postgres
  // recovers, but a backup taken of that directory — the usual "stop the service, tar
  // data/" — captures a database mid-recovery rather than a clean one.
  async close(): Promise<void> {
    try {
      await pg.query("CHECKPOINT");
    } catch {
      // Best-effort WAL flush; close still matters if the checkpoint is refused.
    }
    await pg.close();
  },
};

type ExportedFunction = (...args: any[]) => any;

const fns = new Map<string, ExportedFunction>();

export const functions = {
  get(name: string) { return fns.get(name); },
  call(name: string, ...args: any[]): any {
    const fn = fns.get(name);
    if (!fn) throw new Error(\`Function "\${name}" not found\`);
    return fn(...args);
  },
  register(name: string, fn: ExportedFunction) { fns.set(name, fn); },
};

const templateMap = new Map<string, string>();

export const templates = {
  get(name: string) { return templateMap.get(name); },
  register(name: string, content: string) { templateMap.set(name, content); },
};

export const log = {
  debug(...args: unknown[]) { console.debug(...args); },
  info(...args: unknown[]) { console.info(...args); },
  warn(...args: unknown[]) { console.warn(...args); },
  error(...args: unknown[]) { console.error(...args); },
};

const configMap = new Map<string, unknown>(${configInitializer});

export const config = {
  get(name: string): any { return configMap.get(name); },
  set(name: string, value: any) { configMap.set(name, value); },
  delete(name: string) { return configMap.delete(name); },
};

// Exhaustiveness guard: use in a switch \`default\` over a union so unhandled
// variants fail to type-check (\`default: return assertNever(x);\`).
export function assertNever(x: never): never {
  throw new Error(\`Unexpected value: \${JSON.stringify(x)}\`);
}

// The second argument every route handler is called with. Exported from here
// because a handler module's only import is this file: inside the kernel
// HandlerContext is an ambient LSP declaration, and ambient declarations do not
// survive an export, so without this a handler annotated
// \`(req: Request, ctx: HandlerContext)\` fails the export's \`deno check\` gate.
// \`Request\` and \`Response\` need no equivalent — they are real globals.
export interface HandlerContext {
  readonly params: Readonly<Record<string, string>>;
}

function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    const isDoubleQuoted = value.startsWith('"') && value.endsWith('"');
    const isSingleQuoted = value.startsWith("'") && value.endsWith("'");
    if (isDoubleQuoted || isSingleQuoted) value = value.slice(1, -1);
    if (isDoubleQuoted) {
      value = value.replace(/\\\\n/g, "\\n").replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, "\\\\");
    } else if (value.includes("\\\\n")) {
      value = value.replace(/\\\\n/g, "\\n");
    }
    vars[key] = value;
  }
  return vars;
}

function loadDotEnv(): Record<string, string> {
  try {
    return existsSync(".env") ? parseEnvFile(readFileSync(".env", "utf-8")) : {};
  } catch {
    return {};
  }
}

const dotEnv = loadDotEnv();

function readRuntimeEnv(key: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get(key: string): string | undefined } } }).Deno;
  const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return deno?.env?.get(key) ?? processEnv?.[key] ?? dotEnv[key];
}

export const env: Record<string, string> = new Proxy({} as Record<string, string>, {
  get(_, key: string | symbol) {
    if (typeof key !== "string") return undefined;
    return readRuntimeEnv(key) ?? "";
  },
});
${packagesExport}`;
}

// The permission set an exported app runs with. ONE definition, because this fact
// had three hand-maintained copies — the generated deno.json tasks below,
// `binaryCompileArgs` (core/build.ts) and `APP_RUNTIME_PERMISSIONS`
// (verification/production-build.ts) — and they drifted. A compiled binary and
// `deno task start` must grant the same capabilities, or an app works one way and
// fails the other with nothing to explain why.
//
// --allow-sys is here because npm packages with native-adjacent backends read
// system info at startup. @napi-rs/canvas is the case that bit: it needs it on
// Linux, so a binary compiled without it ran fine on macOS and died in production.
// This is a mild addition to the set, not a widening of trust — the app already
// holds --allow-ffi, which permits running arbitrary native code, while
// --allow-sys exposes only hostname/uid/osRelease-class facts.
export const APP_RUNTIME_PERMISSIONS = [
  "--allow-net",
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-ffi",
  "--allow-sys",
] as const;

// The generated `deno task` command line for the exported entrypoint.
function appTask(flag = ""): string {
  return `deno run --env --no-check ${
    APP_RUNTIME_PERMISSIONS.join(" ")
  } main.ts${flag ? " " + flag : ""}`;
}

function generateDenoJson(packageImports: Record<string, string>): string {
  // Nothing the export emits imports Hono any more, so the Deno artifact does not
  // declare it. (The Node artifact still does — it is the peer of the fetch→node:http
  // server adapter; see core/runtime-dependencies.ts.)
  const imports: Record<string, string> = {
    "@electric-sql/pglite": DENO_RUNTIME_PGLITE_SPECIFIER,
    ...packageImports,
  };
  assertRuntimeDependencyPins(imports, "deno", "deno.json");
  return JSON.stringify(
    {
      tasks: {
        start: appTask(),
        migrate: appTask("--migrate"),
        seed: appTask("--seed"),
        "db:prepare": appTask("--prepare-db"),
        "db:check": appTask("--check-db"),
      },
      imports,
      compilerOptions: { strict: true },
    },
    null,
    2,
  ) + "\n";
}

function generateGitignore(): string {
  return PROJECT_GITIGNORE;
}

function sourceDeclaresAssertNever(source: string): boolean {
  return /(?:^|[;\n])\s*(?:export\s+)?(?:function|const|let|var|class)\s+assertNever\b/
    .test(
      source,
    ) ||
    /(?:^|[;\n])\s*import\b[\s\S]*?\bassertNever\b[\s\S]*?\bfrom\b/.test(
      source,
    );
}

// Whether the source already pulls `Context` in itself. A handler stored with its
// own `import type { Context } from "hono"` must not get a duplicate — it gets its
// specifier repointed instead.
function sourceImportsHonoContext(source: string): boolean {
  return /(?:^|[;\n])\s*import\b[\s\S]*?\bContext\b[\s\S]*?\bfrom\s*["']hono["']/
    .test(source);
}

/* Repoint a source's own Context import at the emitted shim.

   The exported tree has no `hono` import-map entry any more, so a stored source
   carrying `import type { Context } from "hono"` would fail the export's
   `deno check` gate on an unresolvable specifier. The shim re-exports its
   `LegacyContext` as `Context` for exactly this case, so only the specifier moves;
   the import stays type-only and nothing about the handler's behaviour changes.

   Lazy `[\s\S]*?` and no `g` flag: the replacement stops at the FIRST `from "hono"`,
   which is the import the detector above matched. */
function repointLegacyContextImport(source: string, prefix: string): string {
  return source.replace(
    /(import\b[\s\S]*?\bContext\b[\s\S]*?\bfrom\s*)["']hono["']/,
    `$1"${prefix}${CONTEXT_SHIM_PATH}"`,
  );
}

// Whether an emitted module needs the `Context` type at all — either because it
// annotates with it or because it imports it itself. Drives BOTH the import line
// wrapModule adds and whether exportProject emits the shim the line resolves to.
function sourceReferencesLegacyContextType(source: string): boolean {
  return /\bContext\b/.test(source);
}

function wrapModule(source: string, name: string, depth = 1): string {
  const prefix = "../".repeat(depth);
  // The kernel's entity scope (core/reserved-names.ts), as imports. assertNever only
  // when the source calls it and does not declare its own.
  const imports: string[] = ENTITY_SCOPE_NAMES.filter((binding) =>
    binding !== "assertNever"
  );
  if (/\bassertNever\s*\(/.test(source) && !sourceDeclaresAssertNever(source)) {
    imports.push("assertNever");
  }
  // Both of the next two are type-only names that are ambient inside the kernel —
  // the language service declares them, nothing imports them — and ambient
  // declarations do not survive an export. A source annotated with either one and
  // emitted as-is fails the export's `deno check` gate. Derived from the source the
  // same way `assertNever` is, rather than passed in, so a handler that annotates
  // nothing (the overwhelmingly common case) keeps a byte-identical module.
  if (/\bHandlerContext\b/.test(source)) {
    imports.push("type HandlerContext");
  }
  const selfImports = sourceImportsHonoContext(source);
  const contextImport =
    sourceReferencesLegacyContextType(source) && !selfImports
      ? `import type { Context } from "${prefix}${CONTEXT_SHIM_PATH}";\n`
      : "";
  const body = selfImports
    ? repointLegacyContextImport(source, prefix)
    : source;
  return `${contextImport}import { ${
    imports.join(", ")
  } } from "${prefix}deps.ts";\n\n${body}\n\nexport default ${name};\n`;
}

function sanitizeIdentifier(name: string): string {
  return "_pkg_" + name.replace(/[^a-zA-Z0-9_]/g, "_");
}

// The bindings main.ts gives entities. Every one starts with `$`, which the generator
// never uses for its own identifiers (core/export-entity-bindings_test.ts holds it to
// that), so an entity can be named anything that is not reserved in its OWN scope
// (core/reserved-names.ts) without colliding with the shell. Before this a handler was
// imported under its bare name, and one called authGate shadowed a createApp local of
// the same name and crashed the binary at boot. The prefixes differ per kind, so a
// handler and a function with the same name cannot collide with each other either.
function handlerBinding(handlerName: string): string {
  return `$h_${handlerName}`;
}

function functionBinding(functionName: string): string {
  return `$f_${functionName}`;
}

// A legacy handler's shim-adapted form.
function legacyAdapterName(handlerName: string): string {
  return `$legacy_${handlerName}`;
}

function generateMain(
  entities: {
    routes: RouteEntry[];
    templates: TemplateEntry[];
    assets: Array<{ name: string; mimeType: string; module?: string }>;
    authGate: string | null;
  },
  handlerPaths: Map<string, string>,
  functionPaths: Map<string, string>,
  handlerAbis: Map<string, HandlerAbi>,
  validators: GeneratedValidators,
  opts?: Pick<ExportProjectOptions, "projectName" | "projectVersion">,
): string {
  // Pre-sorted by the caller (exportProject) so every emitted registration list
  // is in canonical order.
  const { routes, templates, assets, authGate } = entities;
  const lines: string[] = [];
  lines.push(
    `import {`,
    `  allowedMethods,`,
    `  compileRoutes,`,
    `  type CompiledRoute,`,
    `  match,`,
    `  type RouteDef,`,
    `} from "./${ROUTER_PATH}";`,
  );
  lines.push(
    `import {`,
    `  type RouteValidators,`,
    `  validateRequest,`,
    `} from "./${VALIDATION_PATH}";`,
  );
  // Only when something was generated. An app with no schemas has no validators.ts to
  // import, and importing a file that is not there is the one way this could break an
  // export that works today.
  if (validators.source !== null) {
    lines.push(`import { VALIDATORS } from "./${VALIDATORS_PATH}";`);
  }
  lines.push(`import { db, functions, env, templates } from "./deps.ts";`);
  lines.push(`import { existsSync } from "node:fs";`);
  lines.push(`import { dirname, join } from "node:path";`);
  lines.push(`import { fileURLToPath } from "node:url";`);
  lines.push(``);
  lines.push(
    `const APP_NAME = ${
      JSON.stringify(opts?.projectName ?? DEFAULT_APP_NAME)
    };`,
  );
  lines.push(
    `const APP_VERSION = ${
      JSON.stringify(opts?.projectVersion ?? DEFAULT_APP_VERSION)
    };`,
  );
  lines.push(`const RUNTIME_ROOT = dirname(fileURLToPath(import.meta.url));`);
  lines.push(``);

  for (const [name, path] of handlerPaths) {
    lines.push(`import ${handlerBinding(name)} from "./${path}";`);
  }
  for (const [name, path] of functionPaths) {
    lines.push(`import ${functionBinding(name)} from "./${path}";`);
  }

  lines.push(``);

  // Legacy handlers, adapted once at module scope rather than per request. The shim
  // is the SAME code the kernel wraps them with (core/handler-abi.ts), emitted into
  // the tree — see core/export-context-shim.ts. Before this the exported shell handed
  // them a real Hono Context, which was better fidelity; the shell no longer has one.
  const legacyHandlers = [...handlerPaths.keys()].filter(
    (name) => handlerAbis.get(name) === "legacy-context",
  );
  if (legacyHandlers.length > 0) {
    lines.push(
      `import { type LegacyHandlerFn, wrapLegacyContextHandler } from "./${CONTEXT_SHIM_PATH}";`,
    );
    lines.push(``);
    for (const name of legacyHandlers) {
      lines.push(
        `const ${legacyAdapterName(name)} = wrapLegacyContextHandler(${
          handlerBinding(name)
        } as unknown as LegacyHandlerFn);`,
      );
    }
    lines.push(``);
  }

  // hashString is a pure module-level helper (hoisted); the seed block inside
  // createApp closes over it.
  lines.push(`function hashString(value: string): string {`);
  lines.push(`  let hash = 2166136261;`);
  lines.push(`  for (let i = 0; i < value.length; i++) {`);
  lines.push(`    hash ^= value.charCodeAt(i);`);
  lines.push(`    hash = Math.imul(hash, 16777619);`);
  lines.push(`  }`);
  lines.push(`  return (hash >>> 0).toString(16);`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function splitSqlStatements(sql: string): string[] {`);
  lines.push(`  const statements: string[] = [];`);
  lines.push(`  let start = 0;`);
  lines.push(`  let i = 0;`);
  lines.push(`  while (i < sql.length) {`);
  lines.push(`    const ch = sql[i];`);
  lines.push(`    if (ch === "'") {`);
  lines.push(`      i++;`);
  lines.push(`      while (i < sql.length) {`);
  lines.push(`        if (sql[i] === "'") {`);
  lines.push(`          if (sql[i + 1] === "'") { i += 2; continue; }`);
  lines.push(`          i++;`);
  lines.push(`          break;`);
  lines.push(`        }`);
  lines.push(`        i++;`);
  lines.push(`      }`);
  lines.push(`      continue;`);
  lines.push(`    }`);
  lines.push(`    if (ch === '"') {`);
  lines.push(`      i++;`);
  lines.push(`      while (i < sql.length) {`);
  lines.push(`        if (sql[i] === '"') {`);
  lines.push(`          if (sql[i + 1] === '"') { i += 2; continue; }`);
  lines.push(`          i++;`);
  lines.push(`          break;`);
  lines.push(`        }`);
  lines.push(`        i++;`);
  lines.push(`      }`);
  lines.push(`      continue;`);
  lines.push(`    }`);
  lines.push(`    if (ch === "-" && sql[i + 1] === "-") {`);
  lines.push(`      i += 2;`);
  lines.push(`      while (i < sql.length && sql[i] !== "\\n") i++;`);
  lines.push(`      continue;`);
  lines.push(`    }`);
  lines.push(`    if (ch === "/" && sql[i + 1] === "*") {`);
  lines.push(`      i += 2;`);
  lines.push(
    `      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;`,
  );
  lines.push(`      i = Math.min(sql.length, i + 2);`);
  lines.push(`      continue;`);
  lines.push(`    }`);
  lines.push(`    if (ch === ";") {`);
  lines.push(`      const statement = sql.slice(start, i).trim();`);
  lines.push(`      if (statement) statements.push(statement);`);
  lines.push(`      start = i + 1;`);
  lines.push(`    }`);
  lines.push(`    i++;`);
  lines.push(`  }`);
  lines.push(`  const tail = sql.slice(start).trim();`);
  lines.push(`  if (tail) statements.push(tail);`);
  lines.push(`  return statements;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`function runtimeFile(path: string): string {`);
  lines.push(`  return join(RUNTIME_ROOT, path);`);
  lines.push(`}`);
  lines.push(``);
  lines.push(generateDatabaseUpgradeRuntimeSource());
  lines.push(``);
  lines.push(generateShellRuntimeSource());
  lines.push(``);

  // The fully-wired app, importable without starting a server. Stays async
  // because DB init + seed are awaited here rather than at module top level —
  // a plain `import` of main.ts must not boot the server or touch the database.
  // The entrypoint guard below is the only caller that starts a server; tests
  // (and future export-test harnesses) import createApp and drive app.fetch().
  lines.push(`export async function createApp(): Promise<ExportedApp> {`);
  lines.push(`  assertRuntimeSupport();`);
  for (const name of functionPaths.keys()) {
    lines.push(
      `  functions.register(${JSON.stringify(name)}, ${
        functionBinding(name)
      });`,
    );
  }
  for (const t of templates) {
    lines.push(
      `  templates.register(${JSON.stringify(t.name)}, ${
        JSON.stringify(t.content)
      });`,
    );
  }

  lines.push(``);
  lines.push(`  const initialized = await prepareFreshDatabase();`);
  lines.push(`  if (!initialized) await adoptBundledMigrationsIfCompatible();`);
  lines.push(`  if (initialized) await applyCapturedSeedSqlIfPending();`);
  lines.push(``);
  // The platform routes come FIRST in the table, because precedence is registration
  // order (see core/export-router.ts) and that is where Hono's `app.get` calls put
  // them. A user route matching /_health for some other reason still loses to it,
  // exactly as before.
  const platformRoutes: string[] = [];
  const platformHandlers: string[] = [];

  const claimsPath = (path: string): boolean =>
    routes.some((route) =>
      route.path === path &&
      ["GET", "ALL"].includes(route.method.toUpperCase())
    );

  if (!claimsPath("/_health")) {
    platformRoutes.push(
      `    { method: "GET", path: "/_health", handlerName: ${
        JSON.stringify(PLATFORM_HEALTH_HANDLER)
      } },`,
    );
    platformHandlers.push(
      `    ${JSON.stringify(PLATFORM_HEALTH_HANDLER)}: () =>`,
    );
    platformHandlers.push(
      `      Response.json({ ok: true, name: APP_NAME, version: APP_VERSION }),`,
    );
  }

  if (routes.some((route) => route.schema) && !claimsPath("/openapi.json")) {
    platformRoutes.push(
      `    { method: "GET", path: "/openapi.json", handlerName: ${
        JSON.stringify(PLATFORM_OPENAPI_HANDLER)
      } },`,
    );
    platformHandlers.push(
      `    ${JSON.stringify(PLATFORM_OPENAPI_HANDLER)}: () => {`,
    );
    platformHandlers.push(`      try {`);
    platformHandlers.push(
      `        const content = Deno.readTextFileSync(runtimeFile("openapi.json"));`,
    );
    platformHandlers.push(
      `        return new Response(content, { headers: { "content-type": "application/json; charset=utf-8" } });`,
    );
    platformHandlers.push(`      } catch {`);
    platformHandlers.push(
      `        return textResponse("OpenAPI spec not found", 404);`,
    );
    platformHandlers.push(`      }`);
    platformHandlers.push(`    },`);
  }

  if (assets.length > 0) {
    const assetMap: Record<string, { path: string; mimeType: string }> = {};
    for (const a of assets) {
      const dir = a.module ? `${a.module}/assets` : "assets";
      assetMap[a.name] = { path: `${dir}/${a.name}`, mimeType: a.mimeType };
    }
    lines.push(
      `  const assetFiles: Record<string, { path: string; mimeType: string }> = ${
        JSON.stringify(assetMap)
      };`,
    );
    lines.push(``);
    platformRoutes.push(
      `    { method: "GET", path: "/_assets/:name", handlerName: ${
        JSON.stringify(PLATFORM_ASSETS_HANDLER)
      } },`,
    );
    platformHandlers.push(
      `    ${JSON.stringify(PLATFORM_ASSETS_HANDLER)}: (_request, ctx) => {`,
    );
    platformHandlers.push(`      const asset = assetFiles[ctx.params.name];`);
    platformHandlers.push(
      `      if (!asset) return textResponse("Not found", 404);`,
    );
    platformHandlers.push(`      try {`);
    platformHandlers.push(
      `        const content = Deno.readFileSync(runtimeFile(asset.path));`,
    );
    platformHandlers.push(
      `        return new Response(content, { headers: { "content-type": asset.mimeType } });`,
    );
    platformHandlers.push(`      } catch {`);
    platformHandlers.push(`        return textResponse("Not found", 404);`);
    platformHandlers.push(`      }`);
    platformHandlers.push(`    },`);
  }

  // The route table, in export order. `match` walks it top to bottom and the first
  // acceptable pattern wins — the same resolution the Hono shell had.
  lines.push(`  const routeTable: RouteDef[] = [`);
  lines.push(...platformRoutes);
  for (const route of routes) {
    lines.push(
      `    { method: ${JSON.stringify(route.method)}, path: ${
        JSON.stringify(route.path)
      }, handlerName: ${JSON.stringify(route.handlerName)} },`,
    );
  }
  lines.push(`  ];`);
  lines.push(``);

  // Handlers, by name. A fetch-ABI handler is referenced directly; a legacy one is
  // referenced through its shim adapter (bound at module scope above). Keyed by name
  // and not per route, so two routes sharing a handler share one entry.
  //
  // The request IS cloned now, but only for a route that validates a body — validation
  // reads the body, so the handler's copy has to be taken first. A route with no body
  // schema still gets the original stream and pays nothing. That condition is the whole
  // reason the validators table is consulted before the clone and not after.
  lines.push(`  const handlers: Record<string, RouteHandler> = {`);
  lines.push(...platformHandlers);
  const wired = new Set<string>();
  for (const route of routes) {
    if (wired.has(route.handlerName)) continue;
    wired.add(route.handlerName);
    const target = handlerAbis.get(route.handlerName) === "legacy-context"
      ? legacyAdapterName(route.handlerName)
      : handlerBinding(route.handlerName);
    lines.push(`    ${JSON.stringify(route.handlerName)}: ${target},`);
  }
  lines.push(`  };`);
  lines.push(``);
  // Passed inline rather than bound to a local, so createApp declares one name fewer.
  let gateArg = "";
  if (authGate !== null) {
    const target = handlerAbis.get(authGate) === "legacy-context"
      ? legacyAdapterName(authGate)
      : handlerBinding(authGate);
    gateArg = `, ${target} as unknown as AuthGate`;
  }
  lines.push(
    `  return createFetchApp(routeTable, handlers, ${
      validators.source === null ? "{}" : "VALIDATORS"
    }${gateArg});`,
  );
  lines.push(`}`);
  lines.push(``);
  lines.push(generateServerRuntimeSource());
  lines.push(``);
  // Entrypoint boundary: importing main.ts must NOT start a server; only running
  // it as the entrypoint does. isEntrypoint() is a single predicate so the Node
  // build can retarget it (import.meta.main is undefined under Node ESM) — see
  // rewriteMainForNode in core/build.ts.
  lines.push(`function isEntrypoint(): boolean {`);
  lines.push(`  return import.meta.main === true;`);
  lines.push(`}`);
  lines.push(``);
  lines.push(`if (isEntrypoint()) {`);
  // Before anything else: a named message beats the ReferenceError the first
  // `new URLPattern` would otherwise throw from inside the router.
  lines.push(`  if (typeof URLPattern === "undefined") {`);
  lines.push(`    console.error(URLPATTERN_REQUIRED);`);
  lines.push(`    exitProcess(1);`);
  lines.push(`  }`);
  lines.push(`  const startup = parseStartupOptions(runtimeArgs());`);
  lines.push(`  if (startup.help) {`);
  lines.push(`    console.log(helpText());`);
  lines.push(`    exitProcess(0);`);
  lines.push(`  }`);
  lines.push(`  if (startup.version) {`);
  lines.push(`    console.log(\`\${APP_NAME} \${APP_VERSION}\`);`);
  lines.push(`    exitProcess(0);`);
  lines.push(`  }`);
  lines.push(`  if (startup.error) {`);
  lines.push(`    console.error(startup.error);`);
  lines.push(`    console.error("");`);
  lines.push(`    console.error(helpText());`);
  lines.push(`    exitProcess(1);`);
  lines.push(`  }`);
  lines.push(`  if (startup.action === "check-db") {`);
  lines.push(`    const status = await migrationStatus();`);
  lines.push(`    console.log(status.message);`);
  lines.push(`    exitProcess(status.ok ? 0 : 1);`);
  lines.push(`  }`);
  lines.push(`  if (startup.action === "migrate") {`);
  lines.push(`    const count = await applyPendingMigrations();`);
  lines.push(
    `    console.log(count === 0 ? "No pending migrations." : \`Applied \${count} migration(s).\`);`,
  );
  lines.push(`    exitProcess(0);`);
  lines.push(`  }`);
  lines.push(`  if (startup.action === "seed") {`);
  lines.push(`    const count = await applyReferenceSeeds();`);
  lines.push(
    `    console.log(count === 0 ? "No pending reference seed batches." : \`Applied \${count} reference seed batch(es).\`);`,
  );
  lines.push(`    exitProcess(0);`);
  lines.push(`  }`);
  lines.push(`  if (startup.action === "prepare-db") {`);
  lines.push(`    const result = await prepareDatabase();`);
  lines.push(
    `    console.log(\`Database prepared: initialized=\${result.initialized}, adopted=\${result.adopted}, migrations=\${result.migrations}, referenceSeeds=\${result.seeds}\`);`,
  );
  lines.push(`    exitProcess(0);`);
  lines.push(`  }`);
  lines.push(`  const app = await createApp();`);
  lines.push(`  const dbStatus = await migrationStatus();`);
  lines.push(`  if (!dbStatus.ok) {`);
  lines.push(`    console.error(dbStatus.message);`);
  lines.push(
    `    console.error("Run the database preparation command before starting this release.");`,
  );
  lines.push(`    exitProcess(1);`);
  lines.push(`  }`);
  lines.push(`  const server = await startServer(app, startup);`);
  lines.push(`  registerShutdown(server);`);
  lines.push(`  const address = serverAddress(server);`);
  lines.push(`  const boundPort = address.port ?? startup.port;`);
  lines.push(`  const boundHost = address.hostname ?? startup.hostname;`);
  lines.push(
    `  console.log(\`Server running on http://\${displayHost(boundHost)}:\${boundPort}\`);`,
  );
  lines.push(`}`);
  lines.push(``);

  return lines.join("\n");
}

// The handler-table keys the three generated platform routes are wired under. A colon
// cannot appear in a JavaScript identifier, and handler names are identifiers, so these
// can never collide with a user handler's name.
const PLATFORM_HEALTH_HANDLER = "platform:health";
const PLATFORM_OPENAPI_HANDLER = "platform:openapi";
const PLATFORM_ASSETS_HANDLER = "platform:assets";

/* The app shell: everything the Hono instance used to do apart from matching.

   Every response shape below was measured against Hono 4 + `cors()` as the old shell
   configured it, and reproduced rather than improved — including the two defects noted
   inline. Improving them in the same change that swaps the router would make a smoke
   failure ambiguous between the two. */
function generateShellRuntimeSource(): string {
  return `/** Hono's content-type for a text response once anything has been set. */
const TEXT_PLAIN = "text/plain; charset=UTF-8";

const CORS_ALLOW_ORIGIN_HEADER = "access-control-allow-origin";

// The method list a preflight is answered with, interpolated from core/config.ts so the
// live preview answers the same one. Pinned rather than derived from Hono's \`cors()\`
// default, which changes between versions.
const CORS_ALLOW_METHODS = ${JSON.stringify(CORS_ALLOW_METHODS)};

const URLPATTERN_REQUIRED =
  "This app's router is built on URLPattern, a web standard this runtime does not provide. Run it on Deno, or on Node 24 or newer.";

export interface ExportedApp {
  fetch(request: Request): Promise<Response>;
}

type RouteHandler = (
  request: Request,
  ctx: { readonly params: Readonly<Record<string, string>> },
) => Response | Promise<Response>;

// The app's auth gate: null lets the request through, a Response answers it.
type AuthGate = (
  request: Request,
  ctx: {
    readonly params: Readonly<Record<string, string>>;
    readonly route: { readonly method: string; readonly path: string };
  },
) => Response | null | undefined | Promise<Response | null | undefined>;

function assertRuntimeSupport(): void {
  if (typeof URLPattern === "undefined") throw new Error(URLPATTERN_REQUIRED);
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": TEXT_PLAIN },
  });
}

// The documented error envelope for a route miss, matching what the live preview
// answers (core/app-server.ts) down to the wording. Hono's default was plain text and
// NEVER a 405 — a path registered under another method answered exactly like an
// unregistered one, with no Allow header — which broke CLAUDE.md's rule that a user
// app's framework-level 404/405 envelopes use the same shape as its handlers.
function missResponse(
  request: Request,
  compiled: CompiledRoute[],
  pathname: string,
): Response {
  const allowed = allowedMethods(compiled, pathname);
  if (allowed.length > 0) {
    return envelopeResponse(
      405,
      ${JSON.stringify(ROUTE_METHOD_NOT_ALLOWED_CODE)},
      \`Method \${request.method} is not allowed for \${pathname}.\`,
      { Allow: allowed.join(", ") },
    );
  }
  return envelopeResponse(
    404,
    ${JSON.stringify(ROUTE_NOT_FOUND_CODE)},
    \`No route matches \${request.method} \${pathname}.\`,
  );
}

function envelopeResponse(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: true, code, message }), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

// Hono's default error handler, verbatim: log the error, answer 500 with this body.
function errorResponse(err: unknown): Response {
  console.error(err);
  return textResponse("Internal Server Error", 500);
}

// The CORS preflight answer, measured from \`cors()\`. Reached only when no route in the
// table handles OPTIONS for the path — see createFetchApp.
function preflightResponse(request: Request): Response {
  const headers = new Headers({
    [CORS_ALLOW_ORIGIN_HEADER]: "*",
    "access-control-allow-methods": CORS_ALLOW_METHODS,
  });
  const requested = request.headers.get("access-control-request-headers");
  if (requested !== null) {
    // Comma-joined WITHOUT spaces, and \`vary\` only when the request asked for
    // headers. Both measured.
    headers.set(
      "access-control-allow-headers",
      requested.split(",").map((name) => name.trim()).join(","),
    );
    headers.set("vary", "Access-Control-Request-Headers");
  }
  return new Response(null, { status: 204, headers });
}

// A fresh Response rather than a mutation: a Response from \`Response.redirect()\` has
// an immutable header guard and \`headers.set\` on it throws. Also where HEAD loses its
// body — Hono dispatches HEAD as GET and returns the GET response with no body.
// \`cors\` is false behind an auth gate.
function finalize(response: Response, method: string, cors = true): Response {
  const headers = new Headers(response.headers);
  if (cors) headers.set(CORS_ALLOW_ORIGIN_HEADER, "*");
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Fails CLOSED, like the preview: a throw, or an answer that is neither null nor a
// Response, is a 500. The gate gets a body-less copy so it cannot drain the stream the
// handler is about to read.
async function runGate(
  gate: AuthGate,
  route: RouteDef,
  request: Request,
  params: Readonly<Record<string, string>>,
): Promise<Response | null> {
  const gateReq = new Request(request.url, {
    method: request.method,
    headers: request.headers,
  });
  try {
    const verdict: unknown = await gate(gateReq, {
      params,
      route: { method: route.method, path: route.path },
    });
    if (verdict === null || verdict === undefined) return null;
    if (verdict instanceof Response) return verdict;
    throw new Error(
      \`Auth gate answered \${typeof verdict}; expected null or a Response\`,
    );
  } catch (err) {
    return errorResponse(err);
  }
}

// \`fetch\` is a closure PROPERTY, not a prototype method, because the Node adapter is
// handed it unbound (\`serve({ fetch: app.fetch })\`). A method would lose \`this\` there
// and every request would 500 with nothing in the log to explain it.
function createFetchApp(
  routeTable: RouteDef[],
  handlers: Record<string, RouteHandler>,
  validators: Record<string, RouteValidators>,
  gate: AuthGate | null = null,
): ExportedApp {
  const compiled = compileRoutes(routeTable);
  const cors = gate === null;
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      const hit = match(compiled, request.method, url.pathname);
      const route = hit.route;
      const handler = route ? handlers[route.handlerName] : undefined;
      // The route table gets first refusal on OPTIONS, and the preflight is the
      // fallback. \`cors()\` had it the other way round and answered EVERY OPTIONS
      // request before routing, so an exported app could not serve an OPTIONS handler
      // of its own — not even on an ALL route. A preflight from a browser goes to a
      // path with no OPTIONS handler, so it still lands here.
      if (!route || !handler) {
        return request.method === "OPTIONS" && cors
          ? preflightResponse(request)
          : finalize(
            missResponse(request, compiled, url.pathname),
            request.method,
            cors,
          );
      }
      // After matching and before everything else, platform routes included — the
      // same place the preview gates (core/app-server.ts).
      if (gate !== null) {
        const refused = await runGate(gate, route, request, hit.params);
        if (refused) return finalize(refused, request.method, cors);
      }
      // Keyed by METHOD and PATH, never by handler name: two routes can share one
      // handler and declare different schemas, and keying by handler would validate one
      // against the other's. The live preview keys the same way.
      const rv = validators[\`\${route.method} \${route.path}\`];
      // The handler's copy has to be taken while the body is still unread, because
      // validation below consumes it. Only a route that validates a body pays for the
      // clone; everything else keeps streaming the original.
      const handlerReq = rv?.body ? request.clone() : request;
      if (rv) {
        const bad = await validateRequest(
          rv,
          hit.params,
          url,
          () => request.json(),
        );
        if (bad) return finalize(bad, request.method, cors);
      }
      try {
        return finalize(
          await handler(handlerReq, { params: hit.params }),
          request.method,
          cors,
        );
      } catch (err) {
        return finalize(errorResponse(err), request.method, cors);
      }
    },
  };
}
`;
}

function generateDatabaseUpgradeRuntimeSource(): string {
  return `interface MigrationManifestEntry {
  id: string;
  path: string;
  tableName?: string;
  version?: number;
  sha256: string;
}

interface MigrationManifest {
  formatVersion: number;
  projectVersion?: string;
  migrations: MigrationManifestEntry[];
}

interface ReferenceSeedManifestEntry {
  id: string;
  path: string;
  sha256: string;
}

interface ReferenceSeedManifest {
  formatVersion: number;
  projectVersion?: string;
  seeds: ReferenceSeedManifestEntry[];
}

interface DatabaseCheckResult {
  ok: boolean;
  pending: MigrationManifestEntry[];
  mismatched: Array<{ id: string; expected: string; actual: string }>;
  message: string;
}

const APP_MIGRATIONS_TABLE = "_genie_app_migrations";
const REFERENCE_SEEDS_TABLE = "_genie_reference_seed_batches";

function normalizeSqlFile(content: string): string {
  return content.trim().replace(/;\\s*$/, "") + ";\\n";
}

async function sha256Text(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tableExists(tableName: string): Promise<boolean> {
  const rows = await db.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1",
    [tableName],
  );
  return rows.length > 0;
}

async function hasUserTables(): Promise<boolean> {
  const rows = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT LIKE '\\\\_genie\\\\_%' ESCAPE '\\\\' LIMIT 1",
  );
  return rows.length > 0;
}

function unquoteIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"');
  }
  return trimmed;
}

function readIdentifier(source: string, start: number): { value: string; end: number } | null {
  let i = start;
  while (i < source.length && /\\s/.test(source[i]!)) i++;
  if (source[i] === '"') {
    let raw = '"';
    i++;
    while (i < source.length) {
      raw += source[i]!;
      if (source[i] === '"') {
        if (source[i + 1] === '"') {
          raw += source[i + 1]!;
          i += 2;
          continue;
        }
        i++;
        return { value: unquoteIdentifier(raw), end: i };
      }
      i++;
    }
    return null;
  }
  const match = source.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
  if (!match) return null;
  return { value: match[0], end: i + match[0].length };
}

function createTableName(statement: string): string | null {
  const match = statement.match(/^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?/i);
  if (!match) return null;
  const first = readIdentifier(statement, match[0].length);
  if (!first) return null;
  let table = first.value;
  let i = first.end;
  while (i < statement.length && /\\s/.test(statement[i]!)) i++;
  if (statement[i] === ".") {
    const second = readIdentifier(statement, i + 1);
    if (!second) return null;
    table = second.value;
  }
  return table;
}

function tableDefinitionBody(statement: string): string | null {
  const open = statement.indexOf("(");
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < statement.length; i++) {
    const ch = statement[i];
    if (ch === "'") {
      i++;
      while (i < statement.length) {
        if (statement[i] === "'") {
          if (statement[i + 1] === "'") { i++; } else break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < statement.length) {
        if (statement[i] === '"') {
          if (statement[i + 1] === '"') { i++; } else break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return statement.slice(open + 1, i);
    }
  }
  return null;
}

function splitTopLevelCommaList(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'") {
      i++;
      while (i < value.length) {
        if (value[i] === "'") {
          if (value[i + 1] === "'") { i++; } else break;
        }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < value.length) {
        if (value[i] === '"') {
          if (value[i + 1] === '"') { i++; } else break;
        }
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      const part = value.slice(start, i).trim();
      if (part) parts.push(part);
      start = i + 1;
    }
  }
  const tail = value.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function createTableColumnNames(statement: string): string[] {
  const body = tableDefinitionBody(statement);
  if (!body) return [];
  const columns: string[] = [];
  for (const part of splitTopLevelCommaList(body)) {
    const first = readIdentifier(part, 0);
    if (!first) continue;
    const keyword = first.value.toUpperCase();
    if (["CONSTRAINT", "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "EXCLUDE"].includes(keyword)) {
      continue;
    }
    columns.push(first.value);
  }
  return columns;
}

function createIndexName(statement: string): string | null {
  const match = statement.match(/^\\s*CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?/i);
  if (!match) return null;
  return readIdentifier(statement, match[0].length)?.value ?? null;
}

function alterAddColumn(statement: string): { tableName: string; columnName: string } | null {
  const match = statement.match(/^\\s*ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?/i);
  if (!match) return null;
  const first = readIdentifier(statement, match[0].length);
  if (!first) return null;
  let tableName = first.value;
  let i = first.end;
  while (i < statement.length && /\\s/.test(statement[i]!)) i++;
  if (statement[i] === ".") {
    const second = readIdentifier(statement, i + 1);
    if (!second) return null;
    tableName = second.value;
    i = second.end;
  }
  const addColumnMatch = statement.slice(i).match(/^\\s+ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?/i);
  if (!addColumnMatch) return null;
  const column = readIdentifier(statement, i + addColumnMatch[0].length);
  if (!column) return null;
  return { tableName, columnName: column.value };
}

async function columnExists(tableName: string, columnName: string): Promise<boolean> {
  const rows = await db.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1",
    [tableName, columnName],
  );
  return rows.length > 0;
}

async function indexExists(indexName: string): Promise<boolean> {
  const rows = await db.query(
    "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1 LIMIT 1",
    [indexName],
  );
  return rows.length > 0;
}

async function databaseMatchesBundledSchema(): Promise<boolean> {
  const schemaPath = runtimeFile("schema.sql");
  if (!existsSync(schemaPath)) return false;
  const schema = Deno.readTextFileSync(schemaPath);
  let sawTable = false;
  for (const stmt of splitSqlStatements(schema)) {
    const tableName = createTableName(stmt);
    if (tableName) {
      sawTable = true;
      if (!(await tableExists(tableName))) return false;
      for (const columnName of createTableColumnNames(stmt)) {
        if (!(await columnExists(tableName, columnName))) return false;
      }
      continue;
    }
    const indexName = createIndexName(stmt);
    if (indexName && !(await indexExists(indexName))) return false;
    if (indexName) continue;
    const addColumn = alterAddColumn(stmt);
    if (addColumn) {
      if (!(await tableExists(addColumn.tableName))) return false;
      if (!(await columnExists(addColumn.tableName, addColumn.columnName))) return false;
      continue;
    }
    return false;
  }
  return sawTable;
}

async function createTableStatementMatchesExisting(statement: string): Promise<boolean> {
  const tableName = createTableName(statement);
  if (!tableName) return false;
  if (!(await tableExists(tableName))) return false;
  for (const columnName of createTableColumnNames(statement)) {
    if (!(await columnExists(tableName, columnName))) return false;
  }
  return true;
}

async function ensureMigrationLedger(): Promise<void> {
  await db.execute(
    'CREATE TABLE IF NOT EXISTS "_genie_app_migrations" ("id" text PRIMARY KEY NOT NULL, "hash" text NOT NULL, "app_version" text NOT NULL, "applied_at" text NOT NULL)',
  );
}

async function ensureReferenceSeedLedger(): Promise<void> {
  await db.execute(
    'CREATE TABLE IF NOT EXISTS "_genie_reference_seed_batches" ("id" text PRIMARY KEY NOT NULL, "hash" text NOT NULL, "app_version" text NOT NULL, "applied_at" text NOT NULL)',
  );
}

function readMigrationManifest(): MigrationManifest {
  const manifestPath = runtimeFile("migrations/manifest.json");
  if (!existsSync(manifestPath)) {
    return { formatVersion: 1, projectVersion: APP_VERSION, migrations: [] };
  }
  const parsed = JSON.parse(Deno.readTextFileSync(manifestPath)) as MigrationManifest;
  return {
    formatVersion: parsed.formatVersion,
    projectVersion: parsed.projectVersion,
    migrations: Array.isArray(parsed.migrations) ? parsed.migrations : [],
  };
}

function readReferenceSeedManifest(): ReferenceSeedManifest {
  const manifestPath = runtimeFile("seeds/reference/manifest.json");
  if (!existsSync(manifestPath)) {
    return { formatVersion: 1, projectVersion: APP_VERSION, seeds: [] };
  }
  const parsed = JSON.parse(Deno.readTextFileSync(manifestPath)) as ReferenceSeedManifest;
  return {
    formatVersion: parsed.formatVersion,
    projectVersion: parsed.projectVersion,
    seeds: Array.isArray(parsed.seeds) ? parsed.seeds : [],
  };
}

async function appliedMigrations(): Promise<Map<string, string>> {
  if (!(await tableExists(APP_MIGRATIONS_TABLE))) return new Map();
  const rows = await db.query('SELECT "id", "hash" FROM "_genie_app_migrations"');
  return new Map(rows.map((row) => [String(row.id), String(row.hash)]));
}

async function appliedReferenceSeeds(): Promise<Map<string, string>> {
  if (!(await tableExists(REFERENCE_SEEDS_TABLE))) return new Map();
  const rows = await db.query('SELECT "id", "hash" FROM "_genie_reference_seed_batches"');
  return new Map(rows.map((row) => [String(row.id), String(row.hash)]));
}

async function markBundledMigrationsApplied(): Promise<void> {
  const manifest = readMigrationManifest();
  if (manifest.migrations.length === 0) return;
  await ensureMigrationLedger();
  for (const migration of manifest.migrations) {
    const sql = normalizeSqlFile(Deno.readTextFileSync(runtimeFile(migration.path)));
    const actualHash = await sha256Text(sql);
    if (actualHash !== migration.sha256) {
      throw new Error(\`Bundled migration hash mismatch for \${migration.id}\`);
    }
    await db.execute(
      'INSERT INTO "_genie_app_migrations" ("id", "hash", "app_version", "applied_at") VALUES ($1, $2, $3, CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING',
      [migration.id, migration.sha256, APP_VERSION],
    );
  }
}

async function adoptBundledMigrationsIfCompatible(): Promise<boolean> {
  const manifest = readMigrationManifest();
  if (manifest.migrations.length === 0) return false;
  const applied = await appliedMigrations();
  if (applied.size > 0) return false;
  if (!(await hasUserTables())) return false;
  if (!(await databaseMatchesBundledSchema())) return false;
  await markBundledMigrationsApplied();
  return true;
}

async function prepareFreshDatabase(): Promise<boolean> {
  if (await hasUserTables()) return false;
  const schemaPath = runtimeFile("schema.sql");
  if (!existsSync(schemaPath)) return false;
  const schema = Deno.readTextFileSync(schemaPath);
  for (const stmt of splitSqlStatements(schema)) {
    await db.execute(stmt + ";");
  }
  await markBundledMigrationsApplied();
  return true;
}

async function migrationStatus(): Promise<DatabaseCheckResult> {
  const manifest = readMigrationManifest();
  const applied = await appliedMigrations();
  const pending: MigrationManifestEntry[] = [];
  const mismatched: Array<{ id: string; expected: string; actual: string }> = [];
  for (const migration of manifest.migrations) {
    const actual = applied.get(migration.id);
    if (actual === undefined) {
      pending.push(migration);
    } else if (actual !== migration.sha256) {
      mismatched.push({ id: migration.id, expected: migration.sha256, actual });
    }
  }
  if (mismatched.length > 0) {
    return {
      ok: false,
      pending,
      mismatched,
      message: \`Applied migration hash mismatch: \${mismatched.map((m) => m.id).join(", ")}\`,
    };
  }
  if (pending.length > 0) {
    return {
      ok: false,
      pending,
      mismatched,
      message: \`Pending migrations: \${pending.map((m) => m.id).join(", ")}\`,
    };
  }
  return { ok: true, pending, mismatched, message: "Database schema is current." };
}

async function applyPendingMigrations(): Promise<number> {
  await adoptBundledMigrationsIfCompatible();
  const status = await migrationStatus();
  if (status.mismatched.length > 0) throw new Error(status.message);
  if (status.pending.length === 0) return 0;
  await ensureMigrationLedger();
  let appliedCount = 0;
  for (const migration of status.pending) {
    const sql = normalizeSqlFile(Deno.readTextFileSync(runtimeFile(migration.path)));
    const actualHash = await sha256Text(sql);
    if (actualHash !== migration.sha256) {
      throw new Error(\`Bundled migration hash mismatch for \${migration.id}\`);
    }
    const statements = splitSqlStatements(sql);
    if (statements.length === 1 && await createTableStatementMatchesExisting(statements[0]!)) {
      await db.execute(
        'INSERT INTO "_genie_app_migrations" ("id", "hash", "app_version", "applied_at") VALUES ($1, $2, $3, CURRENT_TIMESTAMP) ON CONFLICT ("id") DO NOTHING',
        [migration.id, migration.sha256, APP_VERSION],
      );
      appliedCount++;
      continue;
    }
    await db.execute("BEGIN");
    try {
      for (const stmt of statements) {
        await db.execute(stmt + ";");
      }
      await db.execute(
        'INSERT INTO "_genie_app_migrations" ("id", "hash", "app_version", "applied_at") VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
        [migration.id, migration.sha256, APP_VERSION],
      );
      await db.execute("COMMIT");
      appliedCount++;
    } catch (err) {
      await db.execute("ROLLBACK");
      throw err;
    }
  }
  return appliedCount;
}

async function applyReferenceSeeds(): Promise<number> {
  const manifest = readReferenceSeedManifest();
  if (manifest.seeds.length === 0) return 0;
  await ensureReferenceSeedLedger();
  const applied = await appliedReferenceSeeds();
  let appliedCount = 0;
  for (const seed of manifest.seeds) {
    const current = applied.get(seed.id);
    if (current !== undefined && current !== seed.sha256) {
      throw new Error(\`Applied reference seed hash mismatch: \${seed.id}\`);
    }
    if (current !== undefined) continue;
    const sql = normalizeSqlFile(Deno.readTextFileSync(runtimeFile(seed.path)));
    const actualHash = await sha256Text(sql);
    if (actualHash !== seed.sha256) {
      throw new Error(\`Bundled reference seed hash mismatch for \${seed.id}\`);
    }
    await db.execute("BEGIN");
    try {
      for (const stmt of splitSqlStatements(sql)) {
        await db.execute(stmt + ";");
      }
      await db.execute(
        'INSERT INTO "_genie_reference_seed_batches" ("id", "hash", "app_version", "applied_at") VALUES ($1, $2, $3, CURRENT_TIMESTAMP)',
        [seed.id, seed.sha256, APP_VERSION],
      );
      await db.execute("COMMIT");
      appliedCount++;
    } catch (err) {
      await db.execute("ROLLBACK");
      throw err;
    }
  }
  return appliedCount;
}

async function applyCapturedSeedSqlIfPending(): Promise<boolean> {
  const seedPath = runtimeFile("seed.sql");
  if (!existsSync(seedPath)) return false;
  const seed = Deno.readTextFileSync(seedPath);
  await db.execute("CREATE TABLE IF NOT EXISTS _genie_seed_meta (key TEXT PRIMARY KEY, applied_at TEXT NOT NULL);");
  const seedKey = "seed.sql:" + hashString(seed);
  const seedMarker = await db.query("SELECT key FROM _genie_seed_meta WHERE key = $1", [seedKey]);
  if (seedMarker.length > 0) return false;
  await db.execute("BEGIN");
  try {
    for (const stmt of splitSqlStatements(seed)) {
      await db.execute(stmt + ";");
    }
    await db.execute("INSERT INTO _genie_seed_meta (key, applied_at) VALUES ($1, CURRENT_TIMESTAMP);", [seedKey]);
    await db.execute("COMMIT");
  } catch (err) {
    await db.execute("ROLLBACK");
    throw err;
  }
  return true;
}

async function prepareDatabase(): Promise<{ initialized: boolean; adopted: boolean; migrations: number; seeds: number }> {
  const initialized = await prepareFreshDatabase();
  const adopted = initialized ? false : await adoptBundledMigrationsIfCompatible();
  const migrations = initialized || adopted ? 0 : await applyPendingMigrations();
  if (initialized) await applyCapturedSeedSqlIfPending();
  const seeds = await applyReferenceSeeds();
  return { initialized, adopted, migrations, seeds };
}`;
}

function generateServerRuntimeSource(): string {
  return `interface StartupOptions {
  hostname: string;
  port: number;
  allowPortFallback: boolean;
  randomizeFirstPort: boolean;
  action?: "serve" | "migrate" | "seed" | "prepare-db" | "check-db";
  help?: boolean;
  version?: boolean;
  error?: string;
}

function runtimeArgs(): string[] {
  const runtime = globalThis as {
    Deno?: { args?: string[] };
    process?: { argv?: string[] };
  };
  return runtime.Deno?.args ?? runtime.process?.argv?.slice(2) ?? [];
}

function helpText(): string {
  return \`Usage:
  app [options]

Options:
  -h, --help              Show this help message.
  -v, --version           Print the app version.
  -p, --port <port|auto>  Bind to a port. "auto" starts on a random available port.
      --host <host>       Bind host. Defaults to HOST or 127.0.0.1.
      --random-port       Start on a random available port.
      --check-db          Check whether bundled migrations are applied.
      --migrate           Apply pending bundled migrations.
      --seed              Apply pending reference seed batches.
      --prepare-db        Initialize a fresh DB or migrate an existing DB, then seed.

Environment:
  PORT                    Default port when --port is not provided.
  HOST                    Default host when --host is not provided.

Examples:
  app --port 8080
  app --host 0.0.0.0 --port 8080
  PORT=8080 app
\`;
}

function exitProcess(code: number): never {
  const runtime = globalThis as {
    Deno?: { exit?: (code?: number) => never };
    process?: { exit?: (code?: number) => never };
  };
  if (runtime.Deno?.exit) runtime.Deno.exit(code);
  if (runtime.process?.exit) runtime.process.exit(code);
  throw new Error(\`Process exited with code \${code}\`);
}

function optionValue(args: string[], index: number, name: string): { value?: string; nextIndex: number; error?: string } {
  const current = args[index] ?? "";
  const eqIndex = current.indexOf("=");
  if (eqIndex !== -1) return { value: current.slice(eqIndex + 1), nextIndex: index };
  const value = args[index + 1];
  if (!value || value.startsWith("-")) return { nextIndex: index, error: \`\${name} requires a value.\` };
  return { value, nextIndex: index + 1 };
}

function parsePort(value: string, source: string): number | "auto" | { error: string } {
  if (value.toLowerCase() === "auto") return "auto";
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { error: \`\${source} must be an integer from 0 to 65535, or "auto".\` };
  }
  return port;
}

function parseStartupOptions(args: string[]): StartupOptions {
  let cliPort: number | "auto" | undefined;
  let cliHost: string | undefined;
  let randomizeFirstPort = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--") {
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      return baseStartupOptions({ help: true });
    }
    if (arg === "-v" || arg === "--version") {
      return baseStartupOptions({ version: true });
    }
    if (arg === "--random-port") {
      randomizeFirstPort = true;
      continue;
    }
    if (arg === "--check-db") {
      return baseStartupOptions({ action: "check-db" });
    }
    if (arg === "--migrate") {
      return baseStartupOptions({ action: "migrate" });
    }
    if (arg === "--seed") {
      return baseStartupOptions({ action: "seed" });
    }
    if (arg === "--prepare-db") {
      return baseStartupOptions({ action: "prepare-db" });
    }
    if (arg === "-p" || arg === "--port" || arg.startsWith("--port=")) {
      const result = optionValue(args, i, "--port");
      if (result.error) return baseStartupOptions({ error: result.error });
      i = result.nextIndex;
      const parsed = parsePort(result.value ?? "", "--port");
      if (typeof parsed === "object") return baseStartupOptions({ error: parsed.error });
      cliPort = parsed;
      continue;
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const result = optionValue(args, i, "--host");
      if (result.error) return baseStartupOptions({ error: result.error });
      i = result.nextIndex;
      cliHost = result.value;
      continue;
    }
    return baseStartupOptions({ error: \`Unknown option: \${arg}\` });
  }

  const envPortValue = env.PORT.trim();
  const envPort = envPortValue ? parsePort(envPortValue, "PORT") : undefined;
  if (typeof envPort === "object") return baseStartupOptions({ error: envPort.error });

  const configuredPort = cliPort ?? envPort;
  const explicitPort = configuredPort !== undefined;
  const autoPort = configuredPort === "auto";
  return {
    hostname: cliHost || env.HOST || "127.0.0.1",
    port: typeof configuredPort === "number" ? configuredPort : 3001,
    allowPortFallback: randomizeFirstPort || autoPort || !explicitPort,
    randomizeFirstPort: randomizeFirstPort || autoPort,
  };
}

function baseStartupOptions(flags: Partial<StartupOptions>): StartupOptions {
  return {
    hostname: "127.0.0.1",
    port: 3001,
    allowPortFallback: true,
    randomizeFirstPort: false,
    ...flags,
  };
}

function randomPort(): number {
  return 20_000 + Math.floor(Math.random() * 40_000);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPortInUseError(err: unknown): boolean {
  const value = err as { name?: string; code?: string; message?: string };
  const message = value.message ?? "";
  return value.name === "AddrInUse" || value.code === "EADDRINUSE" ||
    message.includes("Address already in use") || message.includes("addr in use") ||
    message.includes("EADDRINUSE");
}

async function listenOn(app: ExportedApp, port: number, hostname: string): Promise<unknown> {
  return Deno.serve({ hostname, port, onListen: () => {} }, (req) => app.fetch(req));
}

async function startServer(app: ExportedApp, options: StartupOptions): Promise<unknown> {
  const attempted = new Set<number>();
  let nextPort = options.randomizeFirstPort ? randomPort() : options.port;
  let lastError: unknown;

  for (let attempt = 0; attempt < 50; attempt++) {
    if (attempted.has(nextPort)) {
      nextPort = randomPort();
      continue;
    }
    attempted.add(nextPort);
    try {
      return await listenOn(app, nextPort, options.hostname);
    } catch (err) {
      lastError = err;
      if (!options.allowPortFallback || !isPortInUseError(err)) throw err;
      console.warn(\`Port \${nextPort} is unavailable; trying another port.\`);
      nextPort = randomPort();
    }
  }

  throw new Error(\`Unable to find an available port after \${attempted.size} attempts. Last error: \${errorMessage(lastError)}\`);
}

function serverAddress(server: unknown): { hostname?: string; port?: number } {
  const value = server as {
    addr?: { hostname?: string; port?: number };
    address?: () => unknown;
  };
  const address = value.addr ?? value.address?.();
  if (address && typeof address === "object") {
    const maybeAddress = address as { address?: string; hostname?: string; port?: number };
    return {
      hostname: maybeAddress.hostname ?? maybeAddress.address,
      port: maybeAddress.port,
    };
  }
  return {};
}

function displayHost(hostname: string): string {
  if (hostname === "0.0.0.0" || hostname === "::") return "localhost";
  return hostname;
}

async function stopServer(server: unknown): Promise<void> {
  const handle = server as {
    shutdown?: () => Promise<void>;
    close?: (callback?: (err?: Error) => void) => void;
  };
  if (handle.shutdown) {
    await handle.shutdown.call(server);
    return;
  }
  if (handle.close) {
    await new Promise<void>((resolve, reject) => {
      handle.close?.call(server, (err?: Error) => err ? reject(err) : resolve());
    });
  }
}

// A database that will not close must not keep the process alive: systemd escalates a
// stop that overruns its timeout to SIGKILL, which is the exact unclean exit closing the
// database was meant to avoid.
const DB_CLOSE_TIMEOUT_MS = 5000;

// The timer handle is deliberately not typed as number: this template is type-checked
// as both a Deno and a Node project, and setTimeout returns a different type in each.
async function closeDatabase(): Promise<void> {
  const closable = db as { close?: () => Promise<void> };
  if (!closable.close) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closable.close(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          console.error(\`Database did not close within \${DB_CLOSE_TIMEOUT_MS}ms; exiting anyway.\`);
          resolve();
        }, DB_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    console.error("Database close failed:", err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function registerShutdown(server: unknown): void {
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("Shutting down server...");
    await stopServer(server);
    // After the listener is down, so nothing is mid-query, and before the exit, which
    // is the whole point: exitProcess kills the embedded Postgres where it stands.
    await closeDatabase();
    exitProcess(0);
  };
  // SIGHUP and SIGQUIT alongside the obvious two. This process embeds Postgres, whose
  // emscripten filesystem has no working fsync, so a death that skips closeDatabase()
  // skips the checkpoint and leaves ./data unopenable — not just missing recent writes.
  // Registered one at a time: a runtime that rejects an exotic signal must not take the
  // common ones down with it.
  const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;
  const runtime = globalThis as {
    Deno?: { addSignalListener?: (signal: typeof SHUTDOWN_SIGNALS[number], handler: () => void) => void };
    process?: { on?: (signal: typeof SHUTDOWN_SIGNALS[number], handler: () => void) => void };
  };
  for (const signal of SHUTDOWN_SIGNALS) {
    try {
      runtime.Deno?.addSignalListener?.(signal, () => { void shutdown(); });
    } catch {
      // Some targets do not expose every signal.
    }
    try {
      runtime.process?.on?.(signal, () => { void shutdown(); });
    } catch {
      // Ignore runtimes without signal support.
    }
  }
}`;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time)
      ? sqlStringLiteral(value.toISOString())
      : "NULL";
  }
  if (typeof value === "object") {
    return sqlStringLiteral(JSON.stringify(value));
  }
  return sqlStringLiteral(String(value));
}

function sqlStringLiteral(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function generateAuditReport(kernel: Kernel): string | null {
  const allCategories = [
    ...BUILTIN_AUDIT_CATEGORIES,
    ...kernel.customAudits.list().map((a) => a.name),
  ];
  const results = allCategories
    .map((cat) => kernel.audits.latest(cat))
    .filter((r) => r !== undefined);

  if (results.length === 0) return null;

  const lines: string[] = ["# Audit Report", ""];
  const scores = results.filter((r) => r.score !== null).map((r) => r.score!);
  if (scores.length > 0) {
    const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    lines.push(`**Overall Score:** ${avg}/100`, "");
  }

  for (const r of results) {
    lines.push(
      `## ${r.category.charAt(0).toUpperCase() + r.category.slice(1)}`,
    );
    lines.push("");
    if (r.score !== null) lines.push(`Score: ${r.score}/100`);
    lines.push(
      `Status: ${r.status} | Issues: ${r.issues.length} | ${
        r.completedAt ?? r.startedAt
      }`,
    );
    lines.push("");

    if (r.issues.length > 0) {
      lines.push("| Severity | Rule | Message | Entity |");
      lines.push("|----------|------|---------|--------|");
      for (const i of r.issues) {
        lines.push(
          `| ${i.severity} | ${i.rule} | ${i.message} | ${i.entity ?? "-"} |`,
        );
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function createTarball(files: ExportFile[]): Uint8Array {
  const mtime = deterministicMtime();
  const blocks: Uint8Array[] = [];

  // Stable member order regardless of how the caller assembled `files`.
  const ordered = [...files].sort((a, b) => compareStrings(a.path, b.path));
  for (const file of ordered) {
    const data = fileBytes(file);
    const header = createTarHeader(
      `genie-project/${file.path}`,
      data.byteLength,
      mtime,
    );
    blocks.push(header);
    blocks.push(data);
    const padding = 512 - (data.byteLength % 512);
    if (padding < 512) blocks.push(new Uint8Array(padding));
  }

  blocks.push(new Uint8Array(1024));

  let total = 0;
  for (const b of blocks) total += b.byteLength;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const b of blocks) {
    result.set(b, offset);
    offset += b.byteLength;
  }

  return result;
}

function createTarHeader(
  name: string,
  size: number,
  mtime: number,
): Uint8Array {
  const header = new Uint8Array(512);

  // Fixed owner/group/mode (uid/gid 512, mode 0644) and a fixed mtime — no
  // wall-clock time enters the header, so the archive is reproducible.
  writeString(header, 0, name, 100);
  writeString(header, 100, "0000644", 8);
  writeString(header, 108, "0001000", 8);
  writeString(header, 116, "0001000", 8);
  writeString(header, 124, padOctal(size, 11), 12);
  writeString(header, 136, padOctal(mtime, 11), 12);
  writeString(header, 156, "0", 1);

  // Compute checksum
  writeString(header, 148, "        ", 8);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i]!;
  writeString(header, 148, padOctal(checksum, 6) + "\0 ", 8);

  return header;
}

function writeString(
  buf: Uint8Array,
  offset: number,
  str: string,
  len: number,
): void {
  const bytes = new TextEncoder().encode(str);
  for (let i = 0; i < Math.min(bytes.length, len); i++) {
    buf[offset + i] = bytes[i]!;
  }
}

function padOctal(n: number, width: number): string {
  return n.toString(8).padStart(width, "0");
}
