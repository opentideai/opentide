import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Database } from "./db.ts";
import type { SchemaEntry } from "./types.ts";

export interface DataExportOptions {
  tables?: string[];
  name?: string;
}

export interface DataImportOptions {
  tables?: string[];
  mode?: "truncate" | "append";
}

export interface DataFixtureManifest {
  version: 1;
  tables: Array<{
    tableName: string;
    rowCount: number;
    columns: string[];
  }>;
}

export interface DataExportResult {
  dir: string;
  manifest: DataFixtureManifest;
  files: string[];
}

export interface DataImportResult {
  imported: number;
  tables: Array<{ tableName: string; rowCount: number }>;
}

export interface DataResetResult {
  reset: number;
  tables: string[];
}

export interface DataDeleteResult {
  name: string;
  dir: string;
  deleted: boolean;
}

const DEFAULT_FIXTURE_NAME = "default";

function fixtureDir(projectDir: string, name?: string): string {
  const safeName = sanitizeFixtureName(name ?? DEFAULT_FIXTURE_NAME);
  return join(projectDir, "fixtures", safeName);
}

function sanitizeFixtureName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(
      "Fixture name must contain only letters, digits, dots, dashes, or underscores.",
    );
  }
  return name;
}

function tableFile(dir: string, tableName: string): string {
  return join(dir, `${tableName}.json`);
}

function validateTableName(tableName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`Invalid table name: "${tableName}"`);
  }
}

function validateColumnName(columnName: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(columnName)) {
    throw new Error(`Invalid column name: "${columnName}"`);
  }
}

function selectedSchemas(
  schemas: SchemaEntry[],
  tables?: string[],
): SchemaEntry[] {
  if (!tables || tables.length === 0) return schemas;
  const wanted = new Set(tables);
  const found = new Set(schemas.map((schema) => schema.tableName));
  for (const table of wanted) {
    validateTableName(table);
    if (!found.has(table)) throw new Error(`Unknown table: "${table}"`);
  }
  return schemas.filter((schema) => wanted.has(schema.tableName));
}

function stableRow(row: Record<string, unknown>): Record<string, unknown> {
  const stable: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) stable[key] = row[key];
  return stable;
}

function stableRows(
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  return rows
    .map(stableRow)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function primaryKeyOrderByClause(schema: SchemaEntry): string | null {
  const primary = schema.columns.filter((column) => column.primaryKey);
  if (primary.length === 0) return null;
  return primary.map((column) => `"${column.name}"`).join(", ");
}

export async function exportDataFixture(
  db: Database,
  projectDir: string,
  opts: DataExportOptions = {},
): Promise<DataExportResult> {
  const dir = fixtureDir(projectDir, opts.name);
  mkdirSync(dir, { recursive: true });

  const schemas = selectedSchemas(await db.listSchemas(), opts.tables);
  const files: string[] = [];
  const tables: DataFixtureManifest["tables"] = [];

  for (const schema of schemas) {
    validateTableName(schema.tableName);
    const orderBy = primaryKeyOrderByClause(schema);
    const rows = stableRows(
      await db.query(
        orderBy
          ? `SELECT * FROM "${schema.tableName}" ORDER BY ${orderBy}`
          : `SELECT * FROM "${schema.tableName}"`,
      ),
    );
    const columns = schema.columns.map((column) => column.name);
    for (const column of columns) validateColumnName(column);

    const relPath = `${schema.tableName}.json`;
    writeFileSync(
      tableFile(dir, schema.tableName),
      JSON.stringify(
        {
          tableName: schema.tableName,
          columns,
          rows,
        },
        null,
        2,
      ) + "\n",
    );
    files.push(relPath);
    tables.push({
      tableName: schema.tableName,
      rowCount: rows.length,
      columns,
    });
  }

  const manifest: DataFixtureManifest = {
    version: 1,
    tables,
  };
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  files.unshift("manifest.json");

  return { dir, manifest, files };
}

export async function importDataFixture(
  db: Database,
  projectDir: string,
  opts: DataImportOptions & { name?: string } = {},
): Promise<DataImportResult> {
  const dir = fixtureDir(projectDir, opts.name);
  if (!existsSync(dir)) {
    throw new Error(
      `Fixture not found: "${opts.name ?? DEFAULT_FIXTURE_NAME}"`,
    );
  }

  const schemas = await db.listSchemas();
  const schemaByName = new Map(
    schemas.map((schema) => [schema.tableName, schema]),
  );
  const available = readdirSync(dir)
    .filter((file) => file.endsWith(".json") && file !== "manifest.json")
    .map((file) => file.slice(0, -".json".length))
    .sort();
  const selected = opts.tables && opts.tables.length > 0
    ? opts.tables
    : available;
  const mode = opts.mode ?? "truncate";
  const results: DataImportResult["tables"] = [];

  for (const tableName of selected) {
    validateTableName(tableName);
    const schema = schemaByName.get(tableName);
    if (!schema) {
      throw new Error(`Schema not defined for table: "${tableName}"`);
    }
    const path = tableFile(dir, tableName);
    if (!existsSync(path)) {
      throw new Error(`Fixture table not found: "${tableName}"`);
    }

    const data = JSON.parse(readFileSync(path, "utf-8")) as {
      tableName: string;
      columns: string[];
      rows: Record<string, unknown>[];
    };
    if (data.tableName !== tableName) {
      throw new Error(`Fixture file table mismatch for "${tableName}"`);
    }

    for (const column of data.columns) validateColumnName(column);
    if (mode === "truncate") {
      await db.execute(
        `TRUNCATE TABLE "${tableName}" RESTART IDENTITY CASCADE`,
      );
    }
    await insertRows(db, schema, data.rows);
    results.push({ tableName, rowCount: data.rows.length });
  }

  return {
    imported: results.reduce((sum, table) => sum + table.rowCount, 0),
    tables: results,
  };
}

export function deleteDataFixture(
  projectDir: string,
  name: string,
): DataDeleteResult {
  const safeName = sanitizeFixtureName(name);
  const dir = fixtureDir(projectDir, safeName);
  if (!existsSync(dir)) {
    throw new Error(`Fixture not found: "${safeName}"`);
  }
  rmSync(dir, { recursive: true, force: true });
  return { name: safeName, dir, deleted: true };
}

export async function resetDataTables(
  db: Database,
  tables?: string[],
): Promise<DataResetResult> {
  const schemas = selectedSchemas(await db.listSchemas(), tables);
  for (const schema of schemas) {
    validateTableName(schema.tableName);
    await db.execute(
      `TRUNCATE TABLE "${schema.tableName}" RESTART IDENTITY CASCADE`,
    );
  }
  return {
    reset: schemas.length,
    tables: schemas.map((schema) => schema.tableName),
  };
}

async function insertRows(
  db: Database,
  schema: SchemaEntry,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;
  const schemaColumns = new Set(schema.columns.map((column) => column.name));
  const columns = Object.keys(rows[0]!).sort();
  for (const column of columns) {
    validateColumnName(column);
    if (!schemaColumns.has(column)) {
      throw new Error(
        `Column "${column}" does not exist on "${schema.tableName}"`,
      );
    }
  }

  const batchSize = 100;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params: unknown[] = [];
    const clauses: string[] = [];
    for (let rowIndex = 0; rowIndex < batch.length; rowIndex++) {
      const offset = rowIndex * columns.length;
      clauses.push(
        `(${
          columns.map((_, colIndex) => `$${offset + colIndex + 1}`).join(", ")
        })`,
      );
      for (const column of columns) params.push(batch[rowIndex]![column]);
    }
    await db.execute(
      `INSERT INTO "${schema.tableName}" (${
        columns.map((column) => `"${column}"`).join(", ")
      }) VALUES ${clauses.join(", ")}`,
      params,
    );
  }
}
