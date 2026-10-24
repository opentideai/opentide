import { PGlite } from "@electric-sql/pglite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectPaths } from "./project-manager.ts";
import { isProjectLockHeld } from "./project-lock.ts";
import type { SchemaEntry } from "./types.ts";
import { errorMessage } from "./util.ts";

export interface DynamicSchemaRestoreDiagnostics {
  declaredTables: string[];
  dataDirExists: boolean;
  physicalTables: string[] | null;
  missingTables: string[];
  fixturesDirExists: boolean;
  fixtureManifests: string[];
  fixtureAvailable: boolean;
  dbOpenError?: string;
}

// The project's open database. Asked instead of opening the data directory a
// second time.
export interface OpenDatabase {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

const DYNAMIC_TABLES_SQL = `SELECT tablename
       FROM pg_tables
       WHERE schemaname = 'public'
         AND tablename NOT LIKE '_genie\\_%' ESCAPE '\\'
       ORDER BY tablename`;

export async function diagnoseDynamicSchemaRestore(
  projectDir: string,
  db?: OpenDatabase,
): Promise<DynamicSchemaRestoreDiagnostics> {
  const paths = getProjectPaths(projectDir);
  const declaredTables = listDeclaredDynamicTables(paths.schemaDir);
  const dataDirExists = existsSync(paths.dataDir);
  const physicalReport = !dataDirExists
    ? { tables: null }
    : db
    ? await queryDynamicTables(db)
    : isProjectLockHeld(projectDir)
    // Another process has the database open. A second Postgres on the same
    // directory recovers and checkpoints underneath it, which leaves files
    // that no longer restore.
    ? { tables: null }
    : await listPhysicalDynamicTables(paths.dataDir);
  const physicalTables = physicalReport.tables;
  const fixtureManifests = listFixtureManifests(join(projectDir, "fixtures"));
  const physicalSet = new Set(physicalTables ?? []);
  const missingTables = !dataDirExists
    ? declaredTables
    : physicalTables === null
    ? []
    : declaredTables.filter((tableName) => !physicalSet.has(tableName));

  return {
    declaredTables,
    dataDirExists,
    physicalTables,
    missingTables,
    fixturesDirExists: existsSync(join(projectDir, "fixtures")),
    fixtureManifests,
    fixtureAvailable: fixtureManifests.length > 0,
    ...(physicalReport.error ? { dbOpenError: physicalReport.error } : {}),
  };
}

function listDeclaredDynamicTables(schemaDir: string): string[] {
  if (!existsSync(schemaDir)) return [];
  const tables: string[] = [];
  for (const entry of readdirSync(schemaDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(schemaDir, entry.name);
    try {
      const schema = JSON.parse(readFileSync(path, "utf-8")) as Partial<
        SchemaEntry
      >;
      if (typeof schema.tableName === "string" && schema.tableName.length > 0) {
        tables.push(schema.tableName);
      }
    } catch {
      // Project doctor reports invalid JSON separately; keep this helper
      // diagnostic-only and avoid duplicating parse errors.
    }
  }
  return [...new Set(tables)].sort();
}

function tableNames(rows: Record<string, unknown>[]): string[] {
  return rows.map((row) => String(row.tablename)).sort();
}

async function queryDynamicTables(
  db: OpenDatabase,
): Promise<{ tables: string[] | null; error?: string }> {
  try {
    return { tables: tableNames(await db.query(DYNAMIC_TABLES_SQL)) };
  } catch (err) {
    return { tables: null, error: errorMessage(err) };
  }
}

async function listPhysicalDynamicTables(
  dataDir: string,
): Promise<{ tables: string[] | null; error?: string }> {
  if (!existsSync(join(dataDir, "PG_VERSION"))) return { tables: [] };

  let client: PGlite | null = null;
  try {
    client = new PGlite(dataDir);
    await client.waitReady;
    const result = await client.query(DYNAMIC_TABLES_SQL);
    return { tables: tableNames(result.rows as Record<string, unknown>[]) };
  } catch (err) {
    return { tables: null, error: errorMessage(err) };
  } finally {
    await client?.close().catch(() => {});
  }
}

function listFixtureManifests(fixturesDir: string): string[] {
  if (!existsSync(fixturesDir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(fixturesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const manifest = join(fixturesDir, entry.name, "manifest.json");
      if (existsSync(manifest)) out.push(manifest);
    } else if (entry.isFile() && entry.name === "manifest.json") {
      out.push(join(fixturesDir, entry.name));
    }
  }
  return out.sort();
}
