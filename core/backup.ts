import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Kernel } from "./registries.ts";
import { type Database, referencedTables } from "./db.ts";
import type { SnapshotData } from "./snapshots.ts";
import { type PersistedState, serializeKernelState } from "./persistence.ts";
import { createTimestampedShortId } from "./ids.ts";

export interface BackupMetadata {
  id: string;
  createdAt: string;
  trigger: "shutdown" | "periodic" | "manual";
  tableCount: number;
  rowCount: number;
  branchSnapshotCount?: number;
  includesProjectState?: boolean;
}

interface BackupTable {
  tableName: string;
  sql: string;
  rows: Record<string, unknown>[];
  module?: string;
}

export interface BackupData {
  metadata: BackupMetadata;
  kernelState: PersistedState;
  tables: BackupTable[];
  branchSnapshots?: SnapshotData[];
}

export async function createBackup(
  kernel: Kernel,
  db: Database,
  trigger: BackupMetadata["trigger"],
): Promise<BackupData> {
  const tables: BackupTable[] = [];
  let rowCount = 0;
  for (const schema of await db.listSchemas()) {
    const rows = await db.query(`SELECT * FROM "${schema.tableName}"`);
    tables.push({
      tableName: schema.tableName,
      sql: schema.sql,
      rows,
      ...(schema.module ? { module: schema.module } : {}),
    });
    rowCount += rows.length;
  }

  const branchSnapshots: SnapshotData[] = [];
  const seen = new Set<string>();
  for (const branch of kernel.branches.list()) {
    if (seen.has(branch.snapshotId)) continue;
    seen.add(branch.snapshotId);
    const snap = kernel.snapshots.getBranchSnapshot(branch.snapshotId);
    if (snap) branchSnapshots.push(snap);
  }

  return {
    metadata: {
      id: createTimestampedShortId("backup"),
      createdAt: new Date().toISOString(),
      trigger,
      tableCount: tables.length,
      rowCount,
      branchSnapshotCount: branchSnapshots.length,
      includesProjectState: true,
    },
    kernelState: serializeKernelState(kernel),
    tables,
    ...(branchSnapshots.length > 0 ? { branchSnapshots } : {}),
  };
}

export function saveBackup(
  backup: BackupData,
  backupsDir: string,
  maxBackups: number,
): void {
  mkdirSync(backupsDir, { recursive: true });
  const filePath = join(backupsDir, `${backup.metadata.id}.json`);
  const tmpPath = filePath + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(backup));
  renameSync(tmpPath, filePath);
  pruneBackups(backupsDir, maxBackups);
}

export function listBackups(backupsDir: string): BackupMetadata[] {
  if (!existsSync(backupsDir)) return [];
  const entries: BackupMetadata[] = [];
  for (const file of readdirSync(backupsDir)) {
    if (!file.endsWith(".json") || file.endsWith(".tmp")) continue;
    try {
      const raw = readFileSync(join(backupsDir, file), "utf-8");
      const data = JSON.parse(raw) as BackupData;
      if (data.metadata?.id) {
        entries.push({
          ...data.metadata,
          branchSnapshotCount: data.metadata.branchSnapshotCount ??
            data.branchSnapshots?.length ?? 0,
          includesProjectState: data.metadata.includesProjectState ??
            Boolean(data.kernelState),
        });
      }
    } catch { /* skip unreadable */ }
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return entries;
}

export function loadBackup(backupsDir: string, id: string): BackupData | null {
  const filePath = join(backupsDir, `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as BackupData;
  } catch {
    return null;
  }
}

export function deleteBackup(backupsDir: string, id: string): boolean {
  const filePath = join(backupsDir, `${id}.json`);
  if (!existsSync(filePath)) return false;
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function pruneBackups(backupsDir: string, maxBackups: number): void {
  if (!existsSync(backupsDir)) return;
  const all = listBackups(backupsDir);
  if (all.length <= maxBackups) return;
  for (const old of all.slice(maxBackups)) {
    try {
      unlinkSync(join(backupsDir, `${old.id}.json`));
    } catch { /* ignore */ }
  }
}

export function restoreBranchSnapshots(
  backup: BackupData,
  kernel: Kernel,
  { restoreBranchList = false } = {},
): number {
  if (!backup.branchSnapshots?.length) return 0;
  for (const snap of backup.branchSnapshots) {
    kernel.snapshots.setBranchSnapshot(snap.metadata.id, snap);
  }
  if (restoreBranchList && backup.kernelState.branches?.length) {
    kernel.branches.restore(backup.kernelState.branches);
  }
  return backup.branchSnapshots.length;
}

const BATCH_SIZE = 100;

interface RestoreTablePlan {
  table: BackupTable;
  createSql: string;
  alterSqls: string[];
}

interface SkippedTransientColumn {
  tableName: string;
  columnName: string;
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (ch === "'") {
      current += ch;
      i++;
      while (i < sql.length) {
        current += sql[i]!;
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            current += sql[i + 1]!;
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
      current += ch;
      i++;
      while (i < sql.length) {
        current += sql[i]!;
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            current += sql[i + 1]!;
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

    if (ch === "-" && next === "-") {
      current += ch + next;
      i += 2;
      while (i < sql.length) {
        current += sql[i]!;
        if (sql[i] === "\n") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      current += ch + next;
      i += 2;
      while (i < sql.length) {
        current += sql[i]!;
        if (sql[i] === "*" && sql[i + 1] === "/") {
          current += sql[i + 1]!;
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }

    if (ch === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

function isCreateTableSql(sql: string): boolean {
  return /^\s*CREATE\s+TABLE\b/i.test(sql);
}

function restoreErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\nStatement:")[0]!;
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquoteSqlIdentifier(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll('""', '"');
  }
  return trimmed.toLowerCase();
}

function dropColumnsInStatement(tableName: string, sql: string): string[] {
  const match = sql.match(
    new RegExp(
      `^\\s*ALTER\\s+TABLE\\s+"?${escapedRegExp(tableName)}"?\\s+(.+)$`,
      "is",
    ),
  );
  if (!match) return [];
  return [
    ...match[1]!.matchAll(
      /\bDROP\s+COLUMN\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi,
    ),
  ]
    .map((m) => m[1] ?? m[2]!)
    .map(unquoteSqlIdentifier);
}

function singleAddColumn(sql: string): string | null {
  const match = sql.match(
    /^\s*ALTER\s+TABLE\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\b/is,
  );
  if (!match) return null;
  return unquoteSqlIdentifier(match[1] ?? match[2]!);
}

function referencesMissingBackupTable(
  sql: string,
  knownTables: Set<string>,
): boolean {
  return referencedTables(sql).some((tableName) => !knownTables.has(tableName));
}

function withoutSkippedDropColumn(
  sql: string,
  skipped: SkippedTransientColumn[],
): string | null {
  let next = sql;
  for (const { columnName } of skipped) {
    const ident = escapedRegExp(columnName);
    next = next.replace(
      new RegExp(`\\s*,?\\s*DROP\\s+COLUMN\\s+"?${ident}"?`, "i"),
      "",
    );
  }
  if (!/\bDROP\s+COLUMN\b/i.test(next)) return null;
  return next;
}

function pruneTransientDroppedColumns(
  tableName: string,
  alterSqls: string[],
  knownTables: Set<string>,
): string[] {
  const dropped = new Set(
    alterSqls.flatMap((sql) => dropColumnsInStatement(tableName, sql)),
  );
  const skipped: SkippedTransientColumn[] = [];
  const pruned: string[] = [];

  for (const sql of alterSqls) {
    const addedColumn = singleAddColumn(sql);
    if (
      addedColumn && dropped.has(addedColumn) &&
      referencesMissingBackupTable(sql, knownTables)
    ) {
      skipped.push({ tableName, columnName: addedColumn });
      continue;
    }

    if (
      dropColumnsInStatement(tableName, sql).length > 0 && skipped.length > 0
    ) {
      const rewritten = withoutSkippedDropColumn(
        sql,
        skipped.filter((entry) => entry.tableName === tableName),
      );
      if (rewritten) pruned.push(rewritten);
      continue;
    }

    pruned.push(sql);
  }

  return pruned;
}

function orderRestoreCreates(plans: RestoreTablePlan[]): RestoreTablePlan[] {
  const byTable = new Map(plans.map((plan) => [plan.table.tableName, plan]));
  const tableNames = plans.map((plan) => plan.table.tableName).sort();
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const tableName of tableNames) {
    dependents.set(tableName, new Set());
    indegree.set(tableName, 0);
  }

  for (const plan of plans) {
    const tableName = plan.table.tableName;
    for (
      const dep of referencedTables(plan.createSql)
        .filter((ref) => ref !== tableName && byTable.has(ref))
    ) {
      dependents.get(dep)!.add(tableName);
      indegree.set(tableName, (indegree.get(tableName) ?? 0) + 1);
    }
  }

  const ready = tableNames.filter((tableName) => indegree.get(tableName) === 0);
  const ordered: RestoreTablePlan[] = [];

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
    const restoredNames = new Set(ordered.map((plan) => plan.table.tableName));
    const cycle = tableNames.filter((tableName) =>
      !restoredNames.has(tableName)
    );
    throw new Error(
      `Cannot restore backup schemas: base CREATE TABLE dependency cycle among ${
        cycle.join(", ")
      }`,
    );
  }

  return ordered;
}

function orderRestoreRows(plans: RestoreTablePlan[]): RestoreTablePlan[] {
  const byTable = new Map(plans.map((plan) => [plan.table.tableName, plan]));
  const tableNames = plans.map((plan) => plan.table.tableName).sort();
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const tableName of tableNames) {
    dependents.set(tableName, new Set());
    indegree.set(tableName, 0);
  }

  for (const plan of plans) {
    const tableName = plan.table.tableName;
    const sql = [plan.createSql, ...plan.alterSqls].join("\n");
    for (
      const dep of referencedTables(sql)
        .filter((ref) => ref !== tableName && byTable.has(ref))
    ) {
      dependents.get(dep)!.add(tableName);
      indegree.set(tableName, (indegree.get(tableName) ?? 0) + 1);
    }
  }

  const ready = tableNames.filter((tableName) => indegree.get(tableName) === 0);
  const ordered: RestoreTablePlan[] = [];

  while (ready.length > 0) {
    ready.sort();
    const tableName = ready.shift()!;
    ordered.push(byTable.get(tableName)!);
    for (const dependent of [...dependents.get(tableName)!].sort()) {
      indegree.set(dependent, indegree.get(dependent)! - 1);
      if (indegree.get(dependent) === 0) ready.push(dependent);
    }
  }

  return ordered.length === plans.length ? ordered : plans;
}

export async function restoreDbTables(
  backup: BackupData,
  db: Database,
): Promise<{ restored: number; restoredRows: number; errors: string[] }> {
  const errors: string[] = [];
  let restored = 0;
  let restoredRows = 0;
  const plans: RestoreTablePlan[] = [];
  const knownTables = new Set(backup.tables.map((table) => table.tableName));

  for (const table of backup.tables) {
    const statements = splitSqlStatements(table.sql);
    const [createSql, ...alterSqls] = statements;
    if (!createSql || !isCreateTableSql(createSql)) {
      errors.push(`${table.tableName}: SQL must be a CREATE TABLE statement`);
      continue;
    }
    plans.push({
      table,
      createSql,
      alterSqls: pruneTransientDroppedColumns(
        table.tableName,
        alterSqls,
        knownTables,
      ),
    });
  }

  const created = new Set<string>();
  const failed = new Set<string>();

  try {
    for (const plan of orderRestoreCreates(plans)) {
      try {
        const defined = await db.defineSchema(
          plan.table.tableName,
          plan.createSql,
          plan.table.module,
        );
        if (!defined.ok) {
          throw new Error(defined.error.message);
        }
        created.add(plan.table.tableName);
      } catch (err) {
        failed.add(plan.table.tableName);
        errors.push(
          `${plan.table.tableName}: ${restoreErrorMessage(err)}`,
        );
      }
    }
  } catch (err) {
    errors.push(restoreErrorMessage(err));
  }

  for (const plan of plans) {
    if (
      !created.has(plan.table.tableName) || failed.has(plan.table.tableName)
    ) {
      continue;
    }
    for (const sql of plan.alterSqls) {
      try {
        const altered = await db.alterSchema(
          plan.table.tableName,
          sql,
          plan.table.module,
        );
        if (!altered.ok) {
          throw new Error(altered.error.message);
        }
      } catch (err) {
        failed.add(plan.table.tableName);
        errors.push(
          `${plan.table.tableName}: ${restoreErrorMessage(err)}`,
        );
        break;
      }
    }
  }

  for (const plan of orderRestoreRows(plans)) {
    const table = plan.table;
    if (!created.has(table.tableName) || failed.has(table.tableName)) continue;
    try {
      if (table.rows.length === 0) {
        restored++;
        continue;
      }

      const columns = Object.keys(table.rows[0]!);
      for (const col of columns) {
        // deno-lint-ignore no-control-regex -- the NUL byte is exactly what this rejects: it terminates a C string and would truncate the quoted identifier server-side
        if (/["\\\x00]/.test(col)) {
          throw new Error(`Invalid column name: "${col}"`);
        }
      }

      for (let i = 0; i < table.rows.length; i += BATCH_SIZE) {
        const batch = table.rows.slice(i, i + BATCH_SIZE);
        const valuesClauses: string[] = [];
        const params: unknown[] = [];
        for (let j = 0; j < batch.length; j++) {
          const row = batch[j]!;
          const offset = j * columns.length;
          valuesClauses.push(
            `(${columns.map((_, k) => `$${offset + k + 1}`).join(", ")})`,
          );
          for (const c of columns) params.push(row[c]);
        }
        await db.execute(
          `INSERT INTO "${table.tableName}" (${
            columns.map((c) => `"${c}"`).join(", ")
          }) VALUES ${valuesClauses.join(", ")}`,
          params,
        );
      }
      restored++;
      restoredRows += table.rows.length;
    } catch (err) {
      errors.push(`${table.tableName}: ${restoreErrorMessage(err)}`);
    }
  }

  return { restored, restoredRows, errors };
}
