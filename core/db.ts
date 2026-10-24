import { and, asc, desc, eq, isNull, sql as dsql } from "drizzle-orm";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  genieSchemaMigrationsTable,
  genieSchemasTable,
} from "./db/schema/index.ts";
import {
  createDatabase,
  type DatabaseConnection,
  type DbConfig,
  type DrizzleDb,
  type RawConnection,
} from "./db/factory.ts";
import { DynamicSchemaRegistry } from "./db/dynamic-schema.ts";
import { generateReverseSql } from "./db/reverse-sql.ts";
import type {
  ColumnDef,
  DbInterface,
  MigrationEntry,
  MigrationProvenance,
  Result,
  SchemaEntry,
} from "./types.ts";
import { errorMessage, escapeRegex } from "./util.ts";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "db",
  "migrations",
);

const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFINE_SCHEMA_SINGLE_STATEMENT_SUGGESTION =
  "Pass exactly one CREATE TABLE statement. Put simple uniqueness in the table definition " +
  "(for example, name TEXT UNIQUE) or call alter_schema once for each CREATE INDEX statement " +
  "after the table exists.";

/**
 * Returns true if `sql` contains at most one statement. Scans character by
 * character, skipping single-quoted strings, double-quoted identifiers, line
 * comments, and block comments so that a `;` inside any of those contexts is
 * not treated as a statement separator. A single trailing `;` (optionally
 * followed by whitespace/comments) is allowed. Empty/whitespace-only input is
 * treated as a single (empty) statement. Postgres dollar-quoting is out of
 * scope (function bodies, not table DDL).
 */
export function isSingleStatement(sql: string): boolean {
  let i = 0;
  const n = sql.length;
  let sawSeparator = false;

  while (i < n) {
    const ch = sql[i];

    // Single-quoted string literal.
    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2; // escaped quote, stay in-string
            continue;
          }
          i++; // closing quote
          break;
        }
        i++;
      }
      continue;
    }

    // Double-quoted identifier.
    if (ch === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2; // escaped quote, stay in-identifier
            continue;
          }
          i++; // closing quote
          break;
        }
        i++;
      }
      continue;
    }

    // Line comment.
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }

    // Block comment (no nesting).
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2; // skip closing */
      continue;
    }

    // Statement separator outside any context.
    if (ch === ";") {
      sawSeparator = true;
      i++;
      continue;
    }

    // Any non-whitespace, non-comment character after a separator means a
    // second statement exists.
    if (sawSeparator && ch !== undefined && !/\s/.test(ch)) {
      return false;
    }

    i++;
  }

  return true;
}

type SchemaRow = typeof genieSchemasTable.$inferSelect;
type MigrationRow = typeof genieSchemaMigrationsTable.$inferSelect;

function rowToSchemaEntry(r: SchemaRow): SchemaEntry {
  return {
    tableName: r.tableName,
    columns: r.columns,
    sql: r.sqlSource,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(r.module ? { module: r.module } : {}),
  };
}

function schemaFile(schemaDir: string, tableName: string): string {
  return join(schemaDir, `${tableName}.json`);
}

function schemaMigrationFile(schemaDir: string, tableName: string): string {
  return join(schemaDir, "migrations", `${tableName}.json`);
}

function stableSchemaEntry(entry: SchemaEntry): SchemaEntry {
  return {
    tableName: entry.tableName,
    columns: entry.columns,
    sql: entry.sql,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.module ? { module: entry.module } : {}),
  };
}

function isCreateTableSql(sql: string): boolean {
  return /^\s*CREATE\s+TABLE\b/i.test(sql.trim());
}

function normalizedStatement(sql: string): string {
  return sql.trim().replace(/;\s*$/, "");
}

type SqlIdentifierToken =
  | {
    kind: "identifier";
    value: string;
    quoted: boolean;
    start?: number;
    end?: number;
  }
  | { kind: "dot"; value: "." };

type SqlToken =
  | {
    kind: "identifier";
    value: string;
    quoted: boolean;
    start: number;
    end: number;
  }
  | { kind: "dot"; value: "."; start: number; end: number }
  | { kind: "symbol"; value: "(" | ")" | ","; start: number; end: number };

function normalizeIdentifier(value: string, quoted: boolean): string {
  return quoted ? value : value.toLowerCase();
}

function quoteSqlIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sqlTokens(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i]!;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === '"') {
      let value = "";
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            value += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        value += sql[i]!;
        i++;
      }
      tokens.push({ kind: "identifier", value, quoted: true, start, end: i });
      continue;
    }

    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      continue;
    }

    if (ch === ".") {
      tokens.push({ kind: "dot", value: ".", start: i, end: i + 1 });
      i++;
      continue;
    }

    if (ch === "(" || ch === ")" || ch === ",") {
      tokens.push({ kind: "symbol", value: ch, start: i, end: i + 1 });
      i++;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let value = ch;
      const start = i;
      i++;
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i]!)) {
        value += sql[i]!;
        i++;
      }
      tokens.push({ kind: "identifier", value, quoted: false, start, end: i });
      continue;
    }

    i++;
  }

  return tokens;
}

function sqlIdentifierTokens(sql: string): SqlIdentifierToken[] {
  return sqlTokens(sql).filter((token) =>
    token.kind === "identifier" || token.kind === "dot"
  );
}

export function referencedTables(sql: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const tokens = sqlIdentifierTokens(sql);

  for (let i = 0; i < tokens.length; i++) {
    const references = tokens[i];
    if (
      references?.kind !== "identifier" ||
      references.quoted ||
      normalizeIdentifier(references.value, references.quoted) !== "references"
    ) continue;

    const first = tokens[i + 1];
    if (first?.kind !== "identifier") continue;

    let tableName = normalizeIdentifier(first.value, first.quoted);
    const maybeDot = tokens[i + 2];
    const maybeTable = tokens[i + 3];
    if (maybeDot?.kind === "dot" && maybeTable?.kind === "identifier") {
      const schemaName = normalizeIdentifier(first.value, first.quoted);
      if (schemaName !== "public") continue;
      tableName = normalizeIdentifier(maybeTable.value, maybeTable.quoted);
    }

    if (tableName.startsWith("_genie_")) continue;
    if (seen.has(tableName)) continue;
    seen.add(tableName);
    refs.push(tableName);
  }

  return refs;
}

interface DeferredForeignKeyConstraint {
  tableName: string;
  ordinal: number;
  sql: string;
}

interface DeferredCreateTableSql {
  createSql: string;
  constraints: DeferredForeignKeyConstraint[];
}

interface CreateTableBody {
  prefix: string;
  body: string;
  suffix: string;
}

function isUnquotedKeyword(
  token: SqlToken | undefined,
  keyword: string,
): boolean {
  return token?.kind === "identifier" && !token.quoted &&
    token.value.toLowerCase() === keyword.toLowerCase();
}

function findCreateTableBody(sql: string, tableName: string): CreateTableBody {
  const statement = normalizedStatement(sql);
  if (!isCreateTableSql(statement) || !isSingleStatement(statement)) {
    throw new Error(
      `Cannot defer foreign keys for "${tableName}": base SQL must be a single CREATE TABLE statement.`,
    );
  }

  const tokens = sqlTokens(statement);
  const openIndex = tokens.findIndex((token) =>
    token.kind === "symbol" && token.value === "("
  );
  if (openIndex === -1) {
    throw new Error(
      `Cannot defer foreign keys for "${tableName}": unsupported CREATE TABLE syntax; expected a column definition list.`,
    );
  }

  let depth = 0;
  let closeToken: SqlToken | undefined;
  for (let i = openIndex; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "symbol") continue;
    if (token.value === "(") depth++;
    if (token.value === ")") {
      depth--;
      if (depth === 0) {
        closeToken = token;
        break;
      }
    }
  }

  if (!closeToken) {
    throw new Error(
      `Cannot defer foreign keys for "${tableName}": unsupported CREATE TABLE syntax; unbalanced table definition list.`,
    );
  }

  const trailingTokens = tokens.filter((token) =>
    token.start >= closeToken!.end
  );
  if (trailingTokens.length > 0) {
    throw new Error(
      `Cannot defer foreign keys for "${tableName}": unsupported CREATE TABLE syntax after the column definition list.`,
    );
  }

  const openToken = tokens[openIndex]!;
  return {
    prefix: statement.slice(0, openToken.start),
    body: statement.slice(openToken.end, closeToken.end - 1),
    suffix: statement.slice(closeToken.end),
  };
}

function splitTopLevelCommaList(sql: string): string[] {
  const parts: string[] = [];
  const tokens = sqlTokens(sql);
  let depth = 0;
  let start = 0;

  for (const token of tokens) {
    if (token.kind !== "symbol") continue;
    if (token.value === "(") {
      depth++;
      continue;
    }
    if (token.value === ")") {
      depth--;
      continue;
    }
    if (token.value === "," && depth === 0) {
      parts.push(sql.slice(start, token.start));
      start = token.end;
    }
  }
  parts.push(sql.slice(start));

  return parts;
}

function findMatchingCloseParen(
  tokens: SqlToken[],
  openIndex: number,
): number {
  let depth = 0;
  for (let i = openIndex; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "symbol") continue;
    if (token.value === "(") depth++;
    if (token.value === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function parseReferentialAction(
  tokens: SqlToken[],
  index: number,
): { nextIndex: number; end: number } | null {
  const action = tokens[index];
  if (!action || action.kind !== "identifier" || action.quoted) return null;
  const keyword = action.value.toLowerCase();

  if (keyword === "cascade" || keyword === "restrict") {
    return { nextIndex: index + 1, end: action.end };
  }

  if (keyword === "set") {
    const next = tokens[index + 1];
    if (
      isUnquotedKeyword(next, "null") || isUnquotedKeyword(next, "default")
    ) {
      return { nextIndex: index + 2, end: next!.end };
    }
    return null;
  }

  if (keyword === "no" && isUnquotedKeyword(tokens[index + 1], "action")) {
    return { nextIndex: index + 2, end: tokens[index + 1]!.end };
  }

  return null;
}

function parseReferencesClauseEnd(
  tokens: SqlToken[],
  referencesIndex: number,
  tableName: string,
): { nextIndex: number; end: number } {
  const first = tokens[referencesIndex + 1];
  if (first?.kind !== "identifier") {
    throw new Error(
      `Cannot defer foreign keys for "${tableName}": unsupported REFERENCES clause without a target table.`,
    );
  }

  let index = referencesIndex + 2;
  if (
    tokens[index]?.kind === "dot" &&
    tokens[index + 1]?.kind === "identifier"
  ) {
    index += 2;
  }

  if (tokens[index]?.kind !== "symbol" || tokens[index]!.value !== "(") {
    throw new Error(
      `Cannot defer foreign keys for "${tableName}": unsupported REFERENCES clause without a target column list.`,
    );
  }

  const closeIndex = findMatchingCloseParen(tokens, index);
  if (closeIndex === -1) {
    throw new Error(
      `Cannot defer foreign keys for "${tableName}": unsupported REFERENCES clause with an unbalanced target column list.`,
    );
  }

  index = closeIndex + 1;
  let end = tokens[closeIndex]!.end;
  const seenActions = new Set<string>();

  while (isUnquotedKeyword(tokens[index], "on")) {
    const actionKind = tokens[index + 1];
    if (
      !isUnquotedKeyword(actionKind, "delete") &&
      !isUnquotedKeyword(actionKind, "update")
    ) {
      throw new Error(
        `Cannot defer foreign keys for "${tableName}": unsupported foreign-key action after ON.`,
      );
    }
    const actionKey = normalizeIdentifier(actionKind!.value, false);
    if (seenActions.has(actionKey)) {
      throw new Error(
        `Cannot defer foreign keys for "${tableName}": duplicate ON ${actionKey.toUpperCase()} action.`,
      );
    }
    seenActions.add(actionKey);

    const parsedAction = parseReferentialAction(tokens, index + 2);
    if (!parsedAction) {
      throw new Error(
        `Cannot defer foreign keys for "${tableName}": unsupported ON ${actionKey.toUpperCase()} action.`,
      );
    }
    index = parsedAction.nextIndex;
    end = parsedAction.end;
  }

  return { nextIndex: index, end };
}

function trailingTokensAfter(tokens: SqlToken[], end: number): SqlToken[] {
  return tokens.filter((token) => token.start >= end);
}

function identifierSqlFromToken(token: SqlToken): string {
  if (token.kind !== "identifier") {
    throw new Error("Expected SQL identifier token.");
  }
  return quoteSqlIdentifier(normalizeIdentifier(token.value, token.quoted));
}

function deferCreateTableForeignKeys(
  tableName: string,
  sql: string,
): DeferredCreateTableSql {
  const { prefix, body, suffix } = findCreateTableBody(sql, tableName);
  const entries = splitTopLevelCommaList(body);
  const retainedEntries: string[] = [];
  const constraints: DeferredForeignKeyConstraint[] = [];

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const tokens = sqlTokens(trimmed);
    const referencesIndex = tokens.findIndex((token) =>
      isUnquotedKeyword(token, "references")
    );

    if (referencesIndex === -1) {
      retainedEntries.push(trimmed);
      continue;
    }

    const ordinal = constraints.length + 1;

    if (isUnquotedKeyword(tokens[0], "foreign")) {
      if (!isUnquotedKeyword(tokens[1], "key")) {
        throw new Error(
          `Cannot defer foreign keys for "${tableName}": unsupported table-level foreign-key constraint.`,
        );
      }
      const referencesEnd = parseReferencesClauseEnd(
        tokens,
        referencesIndex,
        tableName,
      );
      if (trailingTokensAfter(tokens, referencesEnd.end).length > 0) {
        throw new Error(
          `Cannot defer foreign keys for "${tableName}": unsupported trailing tokens in table-level foreign-key constraint.`,
        );
      }
      constraints.push({
        tableName,
        ordinal,
        sql: `ALTER TABLE ${quoteSqlIdentifier(tableName)} ADD ${trimmed}`,
      });
      continue;
    }

    if (isUnquotedKeyword(tokens[0], "constraint")) {
      const constraintName = tokens[1];
      if (constraintName?.kind !== "identifier") {
        throw new Error(
          `Cannot defer foreign keys for "${tableName}": named foreign-key constraint is missing its name.`,
        );
      }
      if (
        !isUnquotedKeyword(tokens[2], "foreign") ||
        !isUnquotedKeyword(tokens[3], "key")
      ) {
        throw new Error(
          `Cannot defer foreign keys for "${tableName}": unsupported named constraint with a REFERENCES clause.`,
        );
      }
      const referencesEnd = parseReferencesClauseEnd(
        tokens,
        referencesIndex,
        tableName,
      );
      if (trailingTokensAfter(tokens, referencesEnd.end).length > 0) {
        throw new Error(
          `Cannot defer foreign keys for "${tableName}": unsupported trailing tokens in named foreign-key constraint.`,
        );
      }
      constraints.push({
        tableName,
        ordinal,
        sql: `ALTER TABLE ${quoteSqlIdentifier(tableName)} ADD CONSTRAINT ${
          identifierSqlFromToken(constraintName)
        } ${trimmed.slice(tokens[2]!.start).trim()}`,
      });
      continue;
    }

    const column = tokens[0];
    if (column?.kind !== "identifier") {
      throw new Error(
        `Cannot defer foreign keys for "${tableName}": unsupported column-level foreign-key definition.`,
      );
    }

    let constraintName: string | null = null;
    let removeStart = tokens[referencesIndex]!.start;
    const maybeColumnConstraintName = tokens[referencesIndex - 1];
    if (
      referencesIndex >= 2 &&
      isUnquotedKeyword(tokens[referencesIndex - 2], "constraint") &&
      maybeColumnConstraintName?.kind === "identifier"
    ) {
      constraintName = normalizeIdentifier(
        maybeColumnConstraintName.value,
        maybeColumnConstraintName.quoted,
      );
      removeStart = tokens[referencesIndex - 2]!.start;
    }

    const referencesEnd = parseReferencesClauseEnd(
      tokens,
      referencesIndex,
      tableName,
    );
    if (trailingTokensAfter(tokens, referencesEnd.end).length > 0) {
      throw new Error(
        `Cannot defer foreign keys for "${tableName}": unsupported trailing tokens in column-level foreign-key definition.`,
      );
    }

    const retained = trimmed.slice(0, removeStart).trimEnd();
    if (!retained) {
      throw new Error(
        `Cannot defer foreign keys for "${tableName}": foreign-key column definition would become empty.`,
      );
    }
    retainedEntries.push(retained);
    const constraintPrefix = constraintName
      ? `CONSTRAINT ${quoteSqlIdentifier(constraintName)} `
      : "";
    constraints.push({
      tableName,
      ordinal,
      sql: `ALTER TABLE ${
        quoteSqlIdentifier(tableName)
      } ADD ${constraintPrefix}FOREIGN KEY (${
        identifierSqlFromToken(column)
      }) ${
        trimmed.slice(tokens[referencesIndex]!.start, referencesEnd.end)
          .trim()
      }`,
    });
  }

  if (constraints.length === 0) {
    throw new Error(
      `Cannot defer foreign keys for "${tableName}": cyclic CREATE TABLE did not contain deferrable foreign-key constraints.`,
    );
  }

  return {
    createSql: `${prefix}(${retainedEntries.join(", ")})${suffix}`,
    constraints,
  };
}

interface RestorePlan {
  entry: SchemaEntry;
  exists: boolean;
  activeMigrations: MigrationEntry[];
  baseSql?: string;
  baseMigration?: MigrationEntry;
  postBaseMigrations: MigrationEntry[];
  deferredForeignKeys?: DeferredForeignKeyConstraint[];
}

interface DynamicSchemaRestoreErrorOptions {
  tableName: string;
  migrationVersion?: number;
  sql: string;
  cause: unknown;
}

function sqlPreview(sql: string): string {
  const preview = sql.trim().replace(/\s+/g, " ");
  return preview.length <= 160 ? preview : `${preview.slice(0, 157)}...`;
}

export class DynamicSchemaRestoreError extends Error {
  readonly tableName: string;
  readonly migrationVersion?: number;
  readonly sqlPreview: string;
  readonly originalDbMessage: string;
  override readonly cause: unknown;

  constructor(options: DynamicSchemaRestoreErrorOptions) {
    const originalDbMessage = errorMessage(options.cause);
    const version = options.migrationVersion === undefined
      ? ""
      : ` v${options.migrationVersion}`;
    const preview = sqlPreview(options.sql);
    super(
      `Dynamic schema restore failed while replaying ${options.tableName}${version}: ${originalDbMessage}. SQL: ${preview}`,
    );
    this.name = "DynamicSchemaRestoreError";
    this.tableName = options.tableName;
    this.migrationVersion = options.migrationVersion;
    this.sqlPreview = preview;
    this.originalDbMessage = originalDbMessage;
    this.cause = options.cause;
  }
}

function sortMigrationsForRestore(
  migrations: MigrationEntry[],
): MigrationEntry[] {
  return migrations.toSorted((a, b) => {
    const appliedCmp = (a.appliedAt ?? "").localeCompare(b.appliedAt ?? "");
    if (appliedCmp !== 0) return appliedCmp;
    const tableCmp = a.tableName.localeCompare(b.tableName);
    if (tableCmp !== 0) return tableCmp;
    return a.version - b.version;
  });
}

class BaseCreateDependencyCycleError extends Error {
  readonly tables: string[];

  constructor(tables: string[]) {
    super(
      `Cannot restore dynamic schemas: base CREATE TABLE foreign-key dependency cycle among ${
        tables.join(", ")
      }. Cyclic base table references are not supported.`,
    );
    this.name = "BaseCreateDependencyCycleError";
    this.tables = tables;
  }
}

function baseCreateDependencies(
  plans: RestorePlan[],
): Map<string, Set<string>> {
  const byTable = new Map(plans.map((plan) => [plan.entry.tableName, plan]));
  const dependencies = new Map<string, Set<string>>();

  for (const plan of plans) {
    const tableName = plan.entry.tableName;
    dependencies.set(
      tableName,
      new Set(
        referencedTables(plan.baseSql ?? "")
          .filter((ref) => ref !== tableName && byTable.has(ref)),
      ),
    );
  }

  return dependencies;
}

function cyclicDependencyTables(
  dependencies: Map<string, Set<string>>,
): Set<string> {
  const indexes = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cyclic = new Set<string>();
  let nextIndex = 0;

  function strongConnect(tableName: string): void {
    indexes.set(tableName, nextIndex);
    lowlinks.set(tableName, nextIndex);
    nextIndex++;
    stack.push(tableName);
    onStack.add(tableName);

    for (const dep of [...(dependencies.get(tableName) ?? [])].sort()) {
      if (!indexes.has(dep)) {
        strongConnect(dep);
        lowlinks.set(
          tableName,
          Math.min(lowlinks.get(tableName)!, lowlinks.get(dep)!),
        );
      } else if (onStack.has(dep)) {
        lowlinks.set(
          tableName,
          Math.min(lowlinks.get(tableName)!, indexes.get(dep)!),
        );
      }
    }

    if (lowlinks.get(tableName) !== indexes.get(tableName)) return;

    const component: string[] = [];
    while (true) {
      const table = stack.pop()!;
      onStack.delete(table);
      component.push(table);
      if (table === tableName) break;
    }

    if (component.length > 1) {
      for (const table of component) cyclic.add(table);
    }
  }

  for (const tableName of [...dependencies.keys()].sort()) {
    if (!indexes.has(tableName)) strongConnect(tableName);
  }

  return cyclic;
}

function orderBaseCreates(
  plans: RestorePlan[],
  dependencies = baseCreateDependencies(plans),
): RestorePlan[] {
  const byTable = new Map(plans.map((plan) => [plan.entry.tableName, plan]));
  const tableNames = plans.map((plan) => plan.entry.tableName).sort();
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const tableName of tableNames) {
    dependents.set(tableName, new Set());
    indegree.set(tableName, 0);
  }

  for (const plan of plans) {
    const tableName = plan.entry.tableName;
    for (const dep of dependencies.get(tableName) ?? []) {
      dependents.get(dep)!.add(tableName);
      indegree.set(tableName, (indegree.get(tableName) ?? 0) + 1);
    }
  }

  const ready = tableNames.filter((tableName) => indegree.get(tableName) === 0);
  const ordered: RestorePlan[] = [];

  while (ready.length > 0) {
    ready.sort();
    const tableName = ready.shift()!;
    ordered.push(byTable.get(tableName)!);

    for (const dependent of [...dependents.get(tableName)!].sort()) {
      indegree.set(dependent, indegree.get(dependent)! - 1);
      if (indegree.get(dependent) === 0) ready.push(dependent);
    }
  }

  if (ordered.length !== plans.length) {
    const affected = [...cyclicDependencyTables(dependencies)].sort();
    throw new BaseCreateDependencyCycleError(affected);
  }

  return ordered;
}

// Why a changeset's migrations can't all be reversed, or null when they can.
function changesetMigrationBlocker(
  tagged: MigrationRow[],
  active: MigrationRow[],
  changesetId: string,
): string | null {
  const irreversible = tagged.find((m) => !m.reversible || !m.reverseSql);
  if (irreversible) {
    return `Migration v${irreversible.version} on "${irreversible.tableName}" ` +
      "can't be reversed.";
  }
  const buried = tagged.find((m) =>
    active.some((o) =>
      o.tableName === m.tableName && o.version > m.version &&
      o.changesetId !== changesetId
    )
  );
  return buried
    ? `"${buried.tableName}" has a later migration from outside this changeset.`
    : null;
}

function rowToMigrationEntry(r: MigrationRow): MigrationEntry {
  return {
    id: r.id,
    tableName: r.tableName,
    version: r.version,
    sql: r.sql,
    reverseSql: r.reverseSql,
    reversible: r.reversible,
    columnsBefore: r.columnsBefore,
    columnsAfter: r.columnsAfter,
    appliedAt: r.appliedAt,
    rolledBackAt: r.rolledBackAt,
    turnId: r.turnId,
    changesetId: r.changesetId,
  };
}

export class Database implements DbInterface {
  readonly drizzle: DrizzleDb;
  readonly schemas: DynamicSchemaRegistry;
  private conn: DatabaseConnection;
  private raw: RawConnection;
  private schemaDir?: string;
  private closePromise: Promise<void> | null = null;

  private constructor(
    conn: DatabaseConnection,
    opts: { schemaDir?: string } = {},
  ) {
    this.conn = conn;
    this.drizzle = conn.drizzle;
    this.raw = conn.raw;
    this.schemaDir = opts.schemaDir;
    this.schemas = new DynamicSchemaRegistry();
  }

  /**
   * A consistent snapshot of the whole database, taken while it stays open.
   * Null on a backend that cannot produce one (an external Postgres).
   *
   * Callers wanting a copy of a live database MUST use this rather than copying
   * the data directory: Postgres writes those files continuously, so a
   * file-level copy is a torn snapshot that fails to open.
   */
  snapshot(): Promise<Blob> | null {
    return this.conn.snapshot?.() ?? null;
  }

  static async create(
    config: DbConfig & { schemaDir?: string },
  ): Promise<Database> {
    const conn = await createDatabase(config);
    try {
      await conn.migrate(MIGRATIONS_DIR);
      const db = new Database(conn, { schemaDir: config.schemaDir });
      await db.loadExistingSchemas();
      return db;
    } catch (err) {
      await conn.close().catch(() => {});
      throw err;
    }
  }

  private async loadExistingSchemas(): Promise<void> {
    const entries = await this.listSchemaEntries();
    const restorePlans: RestorePlan[] = [];

    for (const entry of entries) {
      const nameErr = this.validateTableName(entry.tableName);
      if (nameErr?.ok === false) {
        throw new Error(
          `Cannot restore dynamic schema "${entry.tableName}": ${nameErr.error.message}`,
        );
      }

      const activeMigrations = (await this.listMigrationEntries(
        entry.tableName,
      ))
        .filter((m) => m.rolledBackAt === null)
        .sort((a, b) => a.version - b.version);
      const exists = await this.tableExists(entry.tableName);

      if (exists) {
        restorePlans.push({
          entry,
          exists,
          activeMigrations,
          postBaseMigrations: [],
        });
        continue;
      }

      if (activeMigrations.length === 0) {
        if (!isCreateTableSql(entry.sql)) {
          throw new Error(
            `Cannot restore dynamic schema "${entry.tableName}": schema SQL is not a CREATE TABLE statement.`,
          );
        }
        if (!isSingleStatement(entry.sql.trim())) {
          throw new Error(
            `Cannot restore dynamic schema "${entry.tableName}": schema SQL fallback must be a single CREATE TABLE statement when no migration file exists.`,
          );
        }
        restorePlans.push({
          entry,
          exists,
          activeMigrations,
          baseSql: entry.sql,
          postBaseMigrations: [],
        });
        continue;
      }

      const baseIndex = activeMigrations.findLastIndex((migration) =>
        isCreateTableSql(migration.sql)
      );
      if (baseIndex === -1) {
        throw new Error(
          `Cannot restore dynamic schema "${entry.tableName}": active migrations do not include a CREATE TABLE migration.`,
        );
      }

      restorePlans.push({
        entry,
        exists,
        activeMigrations,
        baseSql: activeMigrations[baseIndex]!.sql,
        baseMigration: activeMigrations[baseIndex],
        postBaseMigrations: activeMigrations.slice(baseIndex + 1),
      });
    }

    const missingPlans = restorePlans.filter((plan) => !plan.exists);
    await this.replayMissingDynamicSchemas(missingPlans);

    for (const { entry } of restorePlans) {
      this.schemas.register(entry.tableName, entry.columns);
    }
    await this.backfillMigrations(entries);
  }

  private async replayMissingDynamicSchemas(
    missingPlans: RestorePlan[],
  ): Promise<void> {
    if (missingPlans.length === 0) return;

    const baseDependencies = baseCreateDependencies(missingPlans);
    const cyclicTables = cyclicDependencyTables(baseDependencies);
    const executablePlans = cyclicTables.size === 0
      ? missingPlans
      : missingPlans.map((plan) => {
        if (!cyclicTables.has(plan.entry.tableName)) return plan;
        const deferred = deferCreateTableForeignKeys(
          plan.entry.tableName,
          plan.baseSql!,
        );
        return {
          ...plan,
          baseSql: deferred.createSql,
          deferredForeignKeys: deferred.constraints,
        };
      });

    await this.raw.exec("BEGIN");
    try {
      for (const plan of orderBaseCreates(executablePlans)) {
        try {
          await this.raw.exec(normalizedStatement(plan.baseSql!));
        } catch (err) {
          throw new DynamicSchemaRestoreError({
            tableName: plan.entry.tableName,
            migrationVersion: plan.baseMigration?.version,
            sql: plan.baseSql!,
            cause: err,
          });
        }
      }

      const deferredForeignKeys = executablePlans
        .flatMap((plan) => plan.deferredForeignKeys ?? [])
        .toSorted((a, b) => {
          const tableCmp = a.tableName.localeCompare(b.tableName);
          if (tableCmp !== 0) return tableCmp;
          return a.ordinal - b.ordinal;
        });
      for (const constraint of deferredForeignKeys) {
        try {
          await this.raw.exec(normalizedStatement(constraint.sql));
        } catch (err) {
          throw new DynamicSchemaRestoreError({
            tableName: constraint.tableName,
            sql: constraint.sql,
            cause: err,
          });
        }
      }

      const postBaseMigrations = sortMigrationsForRestore(
        missingPlans.flatMap((plan) => plan.postBaseMigrations),
      );
      for (const migration of postBaseMigrations) {
        try {
          await this.raw.exec(normalizedStatement(migration.sql));
        } catch (err) {
          throw new DynamicSchemaRestoreError({
            tableName: migration.tableName,
            migrationVersion: migration.version,
            sql: migration.sql,
            cause: err,
          });
        }
      }

      await this.raw.exec("COMMIT");
    } catch (err) {
      try {
        await this.raw.exec("ROLLBACK");
      } catch { /* rollback best-effort */ }
      throw err;
    }
  }

  private async backfillMigrations(schemas: SchemaEntry[]): Promise<void> {
    if (schemas.length === 0) return;

    const existing = await this.drizzle
      .select({
        tableName: genieSchemaMigrationsTable.tableName,
        version: genieSchemaMigrationsTable.version,
      })
      .from(genieSchemaMigrationsTable);
    const hasMigration = new Set(
      existing.map((r) => `${r.tableName}:${r.version}`),
    );

    for (const schema of schemas) {
      const migrations = await this.listMigrationEntries(schema.tableName);
      const entries = migrations.length > 0 ? migrations : [{
        id: 1,
        tableName: schema.tableName,
        version: 1,
        sql: schema.sql,
        reverseSql: `DROP TABLE IF EXISTS "${schema.tableName}"`,
        reversible: true,
        columnsBefore: [],
        columnsAfter: schema.columns,
        appliedAt: schema.createdAt,
        rolledBackAt: null,
        turnId: null,
      }];
      for (const entry of entries) {
        if (hasMigration.has(`${entry.tableName}:${entry.version}`)) continue;
        await this.drizzle.insert(genieSchemaMigrationsTable).values({
          tableName: entry.tableName,
          version: entry.version,
          sql: entry.sql,
          reverseSql: entry.reverseSql,
          reversible: entry.reversible,
          columnsBefore: entry.columnsBefore,
          columnsAfter: entry.columnsAfter,
          appliedAt: entry.appliedAt,
          rolledBackAt: entry.rolledBackAt,
          turnId: entry.turnId,
          changesetId: entry.changesetId ?? null,
        });
      }
    }
  }

  async query(
    sql: string,
    params: unknown[] = [],
  ): Promise<Record<string, unknown>[]> {
    try {
      return await this.raw.query(sql, params);
    } catch (err) {
      throw new Error(`SQL error: ${errorMessage(err)}\nQuery: ${sql}`);
    }
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ changes: number }> {
    try {
      const result = await this.raw.execute(sql, params);
      return { changes: result.rowCount };
    } catch (err) {
      throw new Error(`SQL error: ${errorMessage(err)}\nStatement: ${sql}`);
    }
  }

  /**
   * Force everything written so far onto the data directory's files.
   *
   * On PGlite this is not an optimisation, it is the durability boundary: its
   * emscripten filesystem has no working fsync, so a process killed between
   * checkpoints leaves a directory that will not open again. A no-op on an
   * external Postgres, which manages its own checkpoints.
   *
   * Never throws — every caller is on a path (shutdown, a cadence hook) that has
   * nothing useful to do with the failure and must not be blocked by it.
   */
  async checkpoint(): Promise<void> {
    if (this.closePromise) return;
    try {
      await this.conn.checkpoint?.();
    } catch { /* best-effort flush */ }
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.conn.close();
    }
    await this.closePromise;
  }

  async defineSchema(
    tableName: string,
    sqlSource: string,
    module?: string,
    provenance?: MigrationProvenance,
  ): Promise<Result<SchemaEntry>> {
    const nameErr = this.validateTableName(tableName);
    if (nameErr) return nameErr;

    const normalized = sqlSource.trim().replace(/;$/, "");
    if (!/^create\s+table\b/i.test(normalized)) {
      return {
        ok: false,
        error: {
          code: "INVALID_SQL",
          message: "SQL must be a CREATE TABLE statement.",
        },
      };
    }

    if (!isSingleStatement(normalized)) {
      return {
        ok: false,
        error: {
          code: "MULTIPLE_STATEMENTS",
          message: "SQL must be a single statement.",
          suggestion: DEFINE_SCHEMA_SINGLE_STATEMENT_SUGGESTION,
        },
      };
    }

    const existing = await this.getSchemaEntry(tableName);
    if (existing) {
      return {
        ok: false,
        error: {
          code: "TABLE_EXISTS",
          message:
            `Table "${tableName}" already exists. Use alter_schema to modify it.`,
        },
      };
    }

    try {
      await this.raw.exec(normalized);
    } catch (err) {
      return {
        ok: false,
        error: { code: "SQL_ERROR", message: errorMessage(err) },
      };
    }

    const columns = await this.introspectColumns(tableName);
    const now = new Date().toISOString();

    await this.saveSchemaEntry({
      tableName,
      columns,
      sql: sqlSource,
      createdAt: now,
      updatedAt: now,
      ...(module ? { module } : {}),
    });

    this.schemas.register(tableName, columns);

    await this.writeMigration(
      {
        tableName,
        version: 1,
        sql: sqlSource,
        reverseSql: `DROP TABLE IF EXISTS "${tableName}"`,
        reversible: true,
        columnsBefore: [],
        columnsAfter: columns,
        appliedAt: now,
      },
      provenance,
      1,
    );

    return {
      ok: true,
      data: {
        tableName,
        columns,
        sql: sqlSource,
        createdAt: now,
        updatedAt: now,
        ...(module ? { module } : {}),
      },
    };
  }

  // Regroups a table under another module. Metadata only: no DDL runs and no
  // migration is written, so moving a table can't rebuild it or lose rows.
  async setSchemaModule(
    tableName: string,
    module: string | undefined,
  ): Promise<Result<SchemaEntry>> {
    const existing = await this.getSchemaEntry(tableName);
    if (!existing) {
      return {
        ok: false,
        error: {
          code: "TABLE_NOT_FOUND",
          message: `Table "${tableName}" does not exist.`,
        },
      };
    }
    const { module: _previous, ...rest } = existing;
    const next: SchemaEntry = {
      ...rest,
      updatedAt: new Date().toISOString(),
      ...(module ? { module } : {}),
    };
    await this.saveSchemaEntry(next);
    return { ok: true, data: next };
  }

  async alterSchema(
    tableName: string,
    ddlSql: string,
    module?: string,
    provenance?: MigrationProvenance,
  ): Promise<
    Result<
      SchemaEntry & {
        previousSql: string;
        previousModule?: string;
        migration?: MigrationEntry;
      }
    >
  > {
    // Guard before touching the name in file lookups or DDL. The table name
    // is interpolated into raw DDL (DROP/ALTER ... RENAME) which cannot be
    // parameterized, so the allow-list is the only safe gate. Mirrors
    // defineSchema; the existence check below is not a substitute.
    const nameErr = this.validateTableName(tableName);
    if (nameErr) return nameErr;

    const existing = await this.getSchemaEntry(tableName);
    if (!existing) {
      return {
        ok: false,
        error: {
          code: "TABLE_NOT_FOUND",
          message: `Table "${tableName}" does not exist.`,
        },
      };
    }

    // Reject multi-statement SQL before either path executes it (the legacy
    // CREATE-TABLE rebuild path also runs the provided SQL).
    if (!isSingleStatement(ddlSql.trim())) {
      return {
        ok: false,
        error: {
          code: "MULTIPLE_STATEMENTS",
          message: "SQL must be a single statement.",
        },
      };
    }

    const previousSql = existing.sql;
    const previousModule = existing.module;
    const now = new Date().toISOString();
    const resolvedModule = module ?? existing.module;

    const isCreateTable = /^\s*CREATE\s+TABLE\b/i.test(ddlSql.trim());

    if (isCreateTable) {
      return this.alterSchemaLegacy(
        tableName,
        ddlSql,
        existing,
        resolvedModule,
        provenance,
      );
    }

    const columnsBefore = await this.introspectColumns(tableName);
    const reverse = generateReverseSql(ddlSql, tableName, columnsBefore);

    try {
      await this.raw.exec(ddlSql.trim().replace(/;\s*$/, ""));
    } catch (err) {
      return {
        ok: false,
        error: { code: "SQL_ERROR", message: errorMessage(err) },
      };
    }

    const columnsAfter = await this.introspectColumns(tableName);
    const version = await this.nextMigrationVersion(tableName);

    const migration = await this.writeMigration({
      tableName,
      version,
      sql: ddlSql,
      reverseSql: reverse.reverseSql,
      reversible: reverse.reversible,
      columnsBefore,
      columnsAfter,
      appliedAt: now,
    }, provenance);

    // Cumulative DDL: base CREATE TABLE + this (and any prior) incremental
    // statement. The migration row above is already active, so computeSchemaSql
    // includes it. Storing only `ddlSql` here would discard the CREATE TABLE.
    const fullSql = await this.computeSchemaSql(tableName);

    await this.saveSchemaEntry({
      tableName,
      columns: columnsAfter,
      sql: fullSql,
      createdAt: existing.createdAt,
      updatedAt: now,
      ...(resolvedModule ? { module: resolvedModule } : {}),
    });

    this.schemas.register(tableName, columnsAfter);

    return {
      ok: true,
      data: {
        tableName,
        columns: columnsAfter,
        sql: fullSql,
        createdAt: existing.createdAt,
        updatedAt: now,
        previousSql,
        ...(resolvedModule ? { module: resolvedModule } : {}),
        ...(previousModule ? { previousModule } : {}),
        migration,
      },
    };
  }

  private async alterSchemaLegacy(
    tableName: string,
    newSql: string,
    existing: SchemaEntry,
    resolvedModule: string | undefined,
    provenance?: MigrationProvenance,
  ): Promise<
    Result<
      SchemaEntry & {
        previousSql: string;
        previousModule?: string;
        migration: MigrationEntry;
      }
    >
  > {
    const previousSql = existing.sql;
    const previousModule = existing.module;
    const now = new Date().toISOString();
    let columns: ColumnDef[] | undefined;

    try {
      await this.rebuildTable(tableName, newSql, async () => {
        columns = await this.introspectColumns(tableName);
        await this.saveSchemaEntry({
          tableName,
          columns,
          sql: newSql,
          createdAt: existing.createdAt,
          updatedAt: now,
          ...(resolvedModule ? { module: resolvedModule } : {}),
        });
      });
    } catch (err) {
      return {
        ok: false,
        error: { code: "MIGRATION_ERROR", message: errorMessage(err) },
      };
    }

    columns ??= await this.introspectColumns(tableName);
    this.schemas.register(tableName, columns);

    // Record the rebuild as a migration so it becomes a reset point in the
    // history — computeSchemaSql discards prior statements at each CREATE TABLE,
    // so an incremental alter (CREATE INDEX, …) applied after this rebuild
    // rebuilds `.sql` from `newSql`, not the stale original CREATE TABLE. The
    // rebuild copies data across a temp table, which no single reverseSql can
    // undo, so it is marked non-reversible.
    const version = await this.nextMigrationVersion(tableName);
    const migration = await this.writeMigration({
      tableName,
      version,
      sql: newSql,
      reverseSql: "",
      reversible: false,
      columnsBefore: existing.columns,
      columnsAfter: columns,
      appliedAt: now,
    }, provenance);

    return {
      ok: true,
      data: {
        tableName,
        columns,
        sql: newSql,
        createdAt: existing.createdAt,
        updatedAt: now,
        previousSql,
        ...(resolvedModule ? { module: resolvedModule } : {}),
        ...(previousModule ? { previousModule } : {}),
        migration,
      },
    };
  }

  async dropSchema(
    tableName: string,
    provenance?: MigrationProvenance,
  ): Promise<Result<{ tableName: string }>> {
    const nameErr = this.validateTableName(tableName);
    if (nameErr) return nameErr;

    const existing = await this.getSchemaEntry(tableName);
    if (!existing) {
      return {
        ok: false,
        error: {
          code: "TABLE_NOT_FOUND",
          message: `Table "${tableName}" does not exist.`,
        },
      };
    }

    const columnsBefore = await this.introspectColumns(tableName);

    try {
      await this.raw.exec(`DROP TABLE "${tableName}"`);
    } catch (err) {
      return {
        ok: false,
        error: { code: "SQL_ERROR", message: errorMessage(err) },
      };
    }

    const now = new Date().toISOString();
    const version = await this.nextMigrationVersion(tableName);

    await this.writeMigration(
      {
        tableName,
        version,
        sql: `DROP TABLE "${tableName}"`,
        reverseSql: existing.sql,
        reversible: !!existing.sql,
        columnsBefore,
        columnsAfter: [],
        appliedAt: now,
      },
      provenance,
      version,
    );

    await this.deleteSchemaEntry(tableName);

    this.schemas.remove(tableName);

    return { ok: true, data: { tableName } };
  }

  async listSchemas(): Promise<SchemaEntry[]> {
    return await this.listSchemaEntries();
  }

  async getSchema(tableName: string): Promise<Result<SchemaEntry>> {
    const entry = await this.getSchemaEntry(tableName);
    if (!entry) {
      return {
        ok: false,
        error: {
          code: "TABLE_NOT_FOUND",
          message: `Table "${tableName}" does not exist.`,
        },
      };
    }
    return { ok: true, data: entry };
  }

  async listMigrations(tableName: string): Promise<MigrationEntry[]> {
    if (this.schemaDir) {
      return await this.listMigrationEntries(tableName);
    }

    const rows = await this.drizzle
      .select()
      .from(genieSchemaMigrationsTable)
      .where(eq(genieSchemaMigrationsTable.tableName, tableName))
      .orderBy(asc(genieSchemaMigrationsTable.version));

    return rows.map(rowToMigrationEntry);
  }

  async undoMigration(tableName: string): Promise<Result<MigrationEntry>> {
    const all = await this.drizzle
      .select()
      .from(genieSchemaMigrationsTable)
      .where(eq(genieSchemaMigrationsTable.tableName, tableName))
      .orderBy(desc(genieSchemaMigrationsTable.version));

    const latestActive = all.find((m) => m.rolledBackAt === null);
    if (!latestActive) {
      return {
        ok: false,
        error: {
          code: "NO_MIGRATION",
          message: `No active migrations to undo for "${tableName}".`,
        },
      };
    }

    if (!latestActive.reversible || !latestActive.reverseSql) {
      return {
        ok: false,
        error: {
          code: "NOT_REVERSIBLE",
          message: `Migration v${latestActive.version} is not reversible.`,
        },
      };
    }

    try {
      await this.raw.exec(latestActive.reverseSql);
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "SQL_ERROR",
          message: `Undo failed: ${errorMessage(err)}`,
        },
      };
    }

    const now = new Date().toISOString();
    await this.drizzle
      .update(genieSchemaMigrationsTable)
      .set({ rolledBackAt: now })
      .where(eq(genieSchemaMigrationsTable.id, latestActive.id));
    await this.saveMigrationEntry({ ...latestActive, rolledBackAt: now });

    await this.applySchemaStateAfterMigration(tableName, {
      columns: latestActive.columnsBefore,
      now,
    });

    return {
      ok: true,
      data: { ...latestActive, rolledBackAt: now } as MigrationEntry,
    };
  }

  async redoMigration(tableName: string): Promise<Result<MigrationEntry>> {
    const all = await this.drizzle
      .select()
      .from(genieSchemaMigrationsTable)
      .where(eq(genieSchemaMigrationsTable.tableName, tableName))
      .orderBy(asc(genieSchemaMigrationsTable.version));

    const lowestRolledBack = all.find((m) => m.rolledBackAt !== null);
    if (!lowestRolledBack) {
      return {
        ok: false,
        error: {
          code: "NO_MIGRATION",
          message: `No rolled-back migrations to redo for "${tableName}".`,
        },
      };
    }

    try {
      await this.raw.exec(lowestRolledBack.sql.trim().replace(/;\s*$/, ""));
    } catch (err) {
      return {
        ok: false,
        error: {
          code: "SQL_ERROR",
          message: `Redo failed: ${errorMessage(err)}`,
        },
      };
    }

    await this.drizzle
      .update(genieSchemaMigrationsTable)
      .set({ rolledBackAt: null, appliedAt: new Date().toISOString() })
      .where(eq(genieSchemaMigrationsTable.id, lowestRolledBack.id));
    await this.saveMigrationEntry({
      ...lowestRolledBack,
      rolledBackAt: null,
      appliedAt: new Date().toISOString(),
    });

    await this.applySchemaStateAfterMigration(tableName, {
      columns: lowestRolledBack.columnsAfter,
      now: new Date().toISOString(),
    });

    return {
      ok: true,
      data: { ...lowestRolledBack, rolledBackAt: null } as MigrationEntry,
    };
  }

  async rollbackToVersion(
    tableName: string,
    targetVersion: number,
  ): Promise<Result<{ undone: number }>> {
    const toUndo = await this.drizzle
      .select()
      .from(genieSchemaMigrationsTable)
      .where(eq(genieSchemaMigrationsTable.tableName, tableName))
      .orderBy(desc(genieSchemaMigrationsTable.version));

    const active = toUndo.filter((m) =>
      m.rolledBackAt === null && m.version > targetVersion
    );
    if (active.length === 0) {
      return {
        ok: false,
        error: { code: "NO_MIGRATIONS", message: "No migrations to undo." },
      };
    }

    const nonReversible = active.find((m) => !m.reversible || !m.reverseSql);
    if (nonReversible) {
      return {
        ok: false,
        error: {
          code: "NOT_REVERSIBLE",
          message:
            `Migration v${nonReversible.version} is not reversible. Cannot rollback past it.`,
        },
      };
    }

    const now = new Date().toISOString();
    for (const migration of active) {
      try {
        await this.raw.exec(migration.reverseSql!);
        await this.drizzle
          .update(genieSchemaMigrationsTable)
          .set({ rolledBackAt: now })
          .where(eq(genieSchemaMigrationsTable.id, migration.id));
        await this.saveMigrationEntry({ ...migration, rolledBackAt: now });
      } catch (err) {
        await this.refreshSchemaEntry(tableName);
        return {
          ok: false,
          error: {
            code: "ROLLBACK_ERROR",
            message: `Failed at v${migration.version}: ${errorMessage(err)}`,
          },
        };
      }
    }

    await this.refreshSchemaEntry(tableName);
    return { ok: true, data: { undone: active.length } };
  }

  // Reverses every active migration one changeset made, newest first, so the
  // schema reads as it did before the changeset. Checked up front: if any of them
  // can't be reversed, or a later migration from elsewhere sits on top of one,
  // nothing runs. Rows are left alone, except where a reversed DDL drops them.
  async undoChangesetMigrations(
    changesetId: string,
  ): Promise<Result<{ undone: MigrationEntry[] }>> {
    const active = await this.drizzle
      .select()
      .from(genieSchemaMigrationsTable)
      .where(isNull(genieSchemaMigrationsTable.rolledBackAt))
      .orderBy(desc(genieSchemaMigrationsTable.id));
    const tagged = active.filter((m) => m.changesetId === changesetId);
    const blocker = changesetMigrationBlocker(tagged, active, changesetId);
    if (blocker) {
      return {
        ok: false,
        error: {
          code: "CHANGESET_IRREVERSIBLE",
          message: blocker,
          suggestion:
            "Undo that migration by hand, or keep the changeset's schema.",
        },
      };
    }
    const undone: MigrationEntry[] = [];
    for (const migration of tagged) {
      const result = await this.undoMigration(migration.tableName);
      if (!result.ok) {
        return {
          ok: false,
          error: {
            code: "CHANGESET_REWIND_FAILED",
            message: `Undid ${undone.length} of ${tagged.length} migrations, ` +
              `then "${migration.tableName}" v${migration.version} failed: ` +
              result.error.message,
          },
        };
      }
      undone.push(result.data);
    }
    return { ok: true, data: { undone } };
  }

  private async refreshSchemaEntry(tableName: string): Promise<void> {
    const columns = await this.introspectColumns(tableName);
    const now = new Date().toISOString();
    const existing = await this.getSchemaEntry(tableName);
    if (existing) {
      const sql = await this.computeSchemaSql(tableName);
      await this.saveSchemaEntry({ ...existing, columns, sql, updatedAt: now });
    }
    this.schemas.register(tableName, columns);
  }

  private async applySchemaStateAfterMigration(
    tableName: string,
    state: {
      columns: ColumnDef[];
      now: string;
    },
  ): Promise<void> {
    if (state.columns.length === 0) {
      await this.deleteSchemaEntry(tableName);
      this.schemas.remove(tableName);
      return;
    }

    // Rebuild `.sql` from whatever migrations are active now (the caller has
    // already flipped the undone/redone migration's rolledBackAt), so the
    // stored DDL always matches the live migration set.
    const sql = await this.computeSchemaSql(tableName);
    const existing = await this.getSchemaEntry(tableName);
    if (existing) {
      await this.saveSchemaEntry({
        ...existing,
        columns: state.columns,
        updatedAt: state.now,
        sql,
      });
    } else {
      await this.saveSchemaEntry({
        tableName,
        columns: state.columns,
        sql,
        createdAt: state.now,
        updatedAt: state.now,
      });
    }
    this.schemas.register(tableName, state.columns);
  }

  // Reconstruct the full, recreatable DDL for a table from its active
  // (non-rolled-back) migrations. A schema entry's stored `.sql` must be enough
  // to recreate the table AND its indexes/columns from scratch — export/build
  // (schema.sql), the schema entity's SQL view, and the changelog diff all read
  // it. A `CREATE TABLE` migration is a reset point (a full redefinition), so it
  // discards everything before it; every other statement (ALTER ... ADD COLUMN,
  // CREATE INDEX, …) appends. Statements are joined by `;\n\n` with no trailing
  // `;`, matching defineSchema's convention and export's `s.sql + ";"` join.
  private async computeSchemaSql(tableName: string): Promise<string> {
    const active = await this.drizzle
      .select({ sql: genieSchemaMigrationsTable.sql })
      .from(genieSchemaMigrationsTable)
      .where(
        and(
          eq(genieSchemaMigrationsTable.tableName, tableName),
          isNull(genieSchemaMigrationsTable.rolledBackAt),
        ),
      )
      .orderBy(asc(genieSchemaMigrationsTable.version));

    const statements: string[] = [];
    for (const row of active) {
      const stmt = row.sql.trim().replace(/;\s*$/, "");
      if (/^\s*CREATE\s+TABLE\b/i.test(stmt)) statements.length = 0;
      statements.push(stmt);
    }
    return statements.join(";\n\n");
  }

  private async nextMigrationVersion(tableName: string): Promise<number> {
    if (this.schemaDir) {
      const migrations = await this.listMigrationEntries(tableName);
      return Math.max(0, ...migrations.map((m) => m.version)) + 1;
    }

    const [row] = await this.drizzle
      .select({
        maxVersion: dsql<
          number
        >`COALESCE(MAX(${genieSchemaMigrationsTable.version}), 0)`,
      })
      .from(genieSchemaMigrationsTable)
      .where(eq(genieSchemaMigrationsTable.tableName, tableName));
    return (row?.maxVersion ?? 0) + 1;
  }

  private validateTableName(tableName: string): Result<never> | null {
    if (tableName.startsWith("_genie_")) {
      return {
        ok: false,
        error: {
          code: "RESERVED_NAME",
          message: `Table name "${tableName}" is reserved.`,
        },
      };
    }
    if (!VALID_TABLE_NAME.test(tableName)) {
      return {
        ok: false,
        error: {
          code: "INVALID_NAME",
          message:
            `Table name "${tableName}" must contain only letters, digits, and underscores.`,
        },
      };
    }
    return null;
  }

  private async getSchemaEntry(tableName: string): Promise<SchemaEntry | null> {
    if (this.schemaDir) {
      const path = schemaFile(this.schemaDir, tableName);
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf-8")) as SchemaEntry;
    }

    const rows = await this.drizzle
      .select()
      .from(genieSchemasTable)
      .where(eq(genieSchemasTable.tableName, tableName))
      .limit(1);

    return rows[0] ? rowToSchemaEntry(rows[0]) : null;
  }

  private async listSchemaEntries(): Promise<SchemaEntry[]> {
    if (this.schemaDir) {
      if (!existsSync(this.schemaDir)) return [];
      return readdirSync(this.schemaDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) =>
          JSON.parse(
            readFileSync(join(this.schemaDir!, name), "utf-8"),
          ) as SchemaEntry
        )
        .sort((a, b) => a.tableName.localeCompare(b.tableName));
    }

    const rows = await this.drizzle
      .select()
      .from(genieSchemasTable)
      .orderBy(asc(genieSchemasTable.tableName));

    return rows.map(rowToSchemaEntry);
  }

  private async listMigrationEntries(
    tableName: string,
  ): Promise<MigrationEntry[]> {
    if (!this.schemaDir) return [];
    const path = schemaMigrationFile(this.schemaDir, tableName);
    if (!existsSync(path)) return [];
    return (JSON.parse(readFileSync(path, "utf-8")) as MigrationEntry[])
      .sort((a, b) => a.version - b.version);
  }

  // Inserts the migration row and mirrors it into the state file. `stableId`
  // keeps the state file's id independent of the DB's serial where the caller
  // already had one (create = 1, drop = version).
  private async writeMigration(
    fields: Omit<
      MigrationEntry,
      "id" | "rolledBackAt" | "turnId" | "changesetId"
    >,
    provenance: MigrationProvenance = {},
    stableId?: number,
  ): Promise<MigrationEntry> {
    const turnId = provenance.turnId ?? null;
    const changesetId = provenance.changesetId ?? null;
    const [row] = await this.drizzle.insert(genieSchemaMigrationsTable)
      .values({ ...fields, turnId, changesetId }).returning();
    const entry: MigrationEntry = {
      ...fields,
      id: stableId ?? row!.id,
      rolledBackAt: null,
      turnId,
      ...(changesetId ? { changesetId } : {}),
    };
    await this.saveMigrationEntry(entry);
    return entry;
  }

  private async saveMigrationEntry(entry: MigrationEntry): Promise<void> {
    if (!this.schemaDir) return;
    const path = schemaMigrationFile(this.schemaDir, entry.tableName);
    mkdirSync(dirname(path), { recursive: true });
    const existing = await this.listMigrationEntries(entry.tableName);
    const next = existing
      .filter((m) => m.version !== entry.version)
      .concat(entry)
      .sort((a, b) => a.version - b.version);
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  }

  private async saveSchemaEntry(entry: SchemaEntry): Promise<void> {
    if (this.schemaDir) {
      mkdirSync(this.schemaDir, { recursive: true });
      const path = schemaFile(this.schemaDir, entry.tableName);
      writeFileSync(
        path,
        JSON.stringify(stableSchemaEntry(entry), null, 2) + "\n",
      );
      return;
    }

    const existing = await this.getSchemaEntry(entry.tableName);
    if (existing) {
      await this.drizzle
        .update(genieSchemasTable)
        .set({
          columns: entry.columns,
          sqlSource: entry.sql,
          updatedAt: entry.updatedAt,
          module: entry.module ?? null,
        })
        .where(eq(genieSchemasTable.tableName, entry.tableName));
      return;
    }

    await this.drizzle.insert(genieSchemasTable).values({
      tableName: entry.tableName,
      columns: entry.columns,
      sqlSource: entry.sql,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(entry.module ? { module: entry.module } : {}),
    });
  }

  private async deleteSchemaEntry(tableName: string): Promise<void> {
    if (this.schemaDir) {
      const path = schemaFile(this.schemaDir, tableName);
      if (existsSync(path)) unlinkSync(path);
      return;
    }

    await this.drizzle
      .delete(genieSchemasTable)
      .where(eq(genieSchemasTable.tableName, tableName));
  }

  private async tableExists(tableName: string): Promise<boolean> {
    const rows = await this.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_name = $1
       LIMIT 1`,
      [tableName],
    );
    return rows.length > 0;
  }

  private async introspectColumns(tableName: string): Promise<ColumnDef[]> {
    const rows = await this.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_name = $1
       ORDER BY ordinal_position`,
      [tableName],
    );

    const pkRows = await this.query(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [tableName],
    );
    const pkNames = new Set(pkRows.map((r) => r.attname as string));

    return rows.map((r) => ({
      name: r.column_name as string,
      type: (r.data_type as string).toUpperCase(),
      nullable: r.is_nullable === "YES",
      defaultValue: r.column_default as string | null,
      primaryKey: pkNames.has(r.column_name as string),
    }));
  }

  private async rebuildTable(
    tableName: string,
    newSql: string,
    beforeCommit?: () => Promise<void>,
  ): Promise<void> {
    const tmpName = `_genie_rebuild_${tableName}`;
    const escaped = escapeRegex(tableName);
    const createTmp = newSql.replace(
      new RegExp(
        `(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(?:"${escaped}"|${escaped}\\b)`,
        "i",
      ),
      `$1"${tmpName}"`,
    );

    const oldCols = await this.introspectColumns(tableName);
    const oldColNames = new Set(oldCols.map((c) => c.name));

    await this.raw.exec("BEGIN");
    try {
      await this.raw.exec(createTmp);

      const newCols = await this.introspectColumns(tmpName);
      const sharedCols = newCols
        .filter((c) => oldColNames.has(c.name))
        .map((c) => `"${c.name}"`);

      if (sharedCols.length > 0) {
        await this.raw.exec(
          `INSERT INTO "${tmpName}" (${sharedCols.join(", ")}) SELECT ${
            sharedCols.join(", ")
          } FROM "${tableName}"`,
        );
      }

      await this.raw.exec(`DROP TABLE "${tableName}"`);
      await this.raw.exec(`ALTER TABLE "${tmpName}" RENAME TO "${tableName}"`);
      if (beforeCommit) await beforeCommit();
      await this.raw.exec("COMMIT");
    } catch (err) {
      try {
        await this.raw.exec("ROLLBACK");
      } catch { /* rollback best-effort */ }
      throw err;
    }
  }
}

export function validateSchemaConventions(
  columns: ColumnDef[],
  sql: string,
): string[] {
  const warnings: string[] = [];

  const hasPkId = columns.some((c) => c.name === "id" && c.primaryKey);
  if (!hasPkId) {
    warnings.push(
      "Convention: use `id SERIAL PRIMARY KEY` as the first column.",
    );
  }

  const sqlLower = sql.toLowerCase();
  const fkPattern = /(\w+)\s+\w+.*?references\s+(\w+)/gi;
  const columnsWithRef = new Set<string>();
  for (const m of sqlLower.matchAll(fkPattern)) columnsWithRef.add(m[1]!);

  for (const col of columns) {
    if (col.name.endsWith("_id") && col.name !== "id") {
      if (!columnsWithRef.has(col.name.toLowerCase())) {
        const prefix = col.name.slice(0, -3);
        const expectedTable = prefix.endsWith("s") ? prefix : prefix + "s";
        warnings.push(
          `Convention: column "${col.name}" looks like a foreign key — add \`REFERENCES ${expectedTable}(id)\`.`,
        );
      }
    }
  }

  return warnings;
}
