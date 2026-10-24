import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  diagnoseDynamicSchemaRestore,
  type OpenDatabase,
} from "./dynamic-schema-restore-diagnostics.ts";
import { getProjectPaths } from "./project-manager.ts";
import type {
  MigrationEntry,
  SchemaEntry,
  StoredMessage,
  TurnUsage,
} from "./types.ts";
import type { Changeset } from "./types.ts";
import type { ChangeRecord } from "./changelog.ts";

export type DoctorSeverity = "error" | "warning";

export interface DoctorIssue {
  severity: DoctorSeverity;
  code: string;
  path: string;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  errors: DoctorIssue[];
  warnings: DoctorIssue[];
  counts: {
    stateFiles: number;
    schemas: number;
    schemaMigrations: number;
    sessions: number;
    messages: number;
    usageRecords: number;
    changesets: number;
    changelogRecords: number;
  };
  sync: {
    shareable: string[];
    localOnly: string[];
    dataIgnoredByGit: boolean | null;
  };
}

type JsonObject = Record<string, unknown>;

interface FileChangeRecord extends ChangeRecord {
  uid?: string;
}

const EMPTY_COUNTS: DoctorReport["counts"] = {
  stateFiles: 0,
  schemas: 0,
  schemaMigrations: 0,
  sessions: 0,
  messages: 0,
  usageRecords: 0,
  changesets: 0,
  changelogRecords: 0,
};

// Pass the project's open database when there is one; without it the check
// opens the data directory itself, and skips that when another process holds it.
export async function doctorProject(
  projectDir: string,
  db?: OpenDatabase,
): Promise<DoctorReport> {
  const issues: DoctorIssue[] = [];
  const counts = { ...EMPTY_COUNTS };
  const paths = getProjectPaths(projectDir);
  const sync: DoctorReport["sync"] = {
    shareable: [paths.stateDir, paths.historyDir, join(projectDir, "fixtures")],
    localOnly: [paths.dataDir],
    dataIgnoredByGit: gitIgnoresPath(projectDir, "data/"),
  };

  const addIssue = (
    severity: DoctorSeverity,
    code: string,
    path: string,
    message: string,
  ) => issues.push({ severity, code, path, message });

  if (!existsSync(paths.manifest)) {
    addIssue(
      "error",
      "MISSING_MANIFEST",
      paths.manifest,
      "Project manifest is missing.",
    );
  } else {
    readJson<JsonObject>(paths.manifest, addIssue);
  }

  const stateFiles = listJsonFiles(paths.stateDir)
    .filter((path) => !path.startsWith(paths.schemaDir + "/"));
  for (const path of stateFiles) {
    if (readJson<unknown>(path, addIssue) !== null) counts.stateFiles++;
  }

  const schemaByName = new Map<string, SchemaEntry>();
  for (
    const path of listJsonFiles(paths.schemaDir).filter((path) =>
      !path.includes("/migrations/")
    )
  ) {
    const schema = readJson<SchemaEntry>(path, addIssue);
    if (!schema) continue;
    counts.schemas++;
    if (!isNonEmptyString(schema.tableName)) {
      addIssue("error", "INVALID_SCHEMA", path, "Schema is missing tableName.");
      continue;
    }
    if (schemaByName.has(schema.tableName)) {
      addIssue(
        "error",
        "DUPLICATE_SCHEMA",
        path,
        `Duplicate schema for table "${schema.tableName}".`,
      );
    }
    schemaByName.set(schema.tableName, schema);
    if (!Array.isArray(schema.columns)) {
      addIssue(
        "error",
        "INVALID_SCHEMA",
        path,
        `Schema "${schema.tableName}" is missing columns.`,
      );
    }
    if (!isNonEmptyString(schema.sql)) {
      addIssue(
        "error",
        "INVALID_SCHEMA",
        path,
        `Schema "${schema.tableName}" is missing SQL.`,
      );
    }
  }

  for (const path of listJsonFiles(join(paths.schemaDir, "migrations"))) {
    const migrations = readJson<MigrationEntry[]>(path, addIssue);
    if (!migrations) continue;
    if (!Array.isArray(migrations)) {
      addIssue(
        "error",
        "INVALID_SCHEMA_MIGRATIONS",
        path,
        "Schema migration file must contain an array.",
      );
      continue;
    }
    const versions = new Set<number>();
    const tableName = path.slice(path.lastIndexOf("/") + 1, -".json".length);
    const droppedTables = new Map<string, boolean>();
    for (const migration of migrations) {
      counts.schemaMigrations++;
      if (migration.tableName !== tableName) {
        addIssue(
          "error",
          "SCHEMA_MIGRATION_MISMATCH",
          path,
          `Migration tableName "${migration.tableName}" does not match file "${tableName}".`,
        );
      }
      const tableWasDropped = droppedTables.get(migration.tableName) ??
        latestActiveMigrationDropsTable(migrations, migration.tableName);
      droppedTables.set(migration.tableName, tableWasDropped);
      if (!schemaByName.has(migration.tableName) && !tableWasDropped) {
        addIssue(
          "error",
          "SCHEMA_MIGRATION_ORPHAN",
          path,
          `Migration references missing schema "${migration.tableName}".`,
        );
      }
      if (versions.has(migration.version)) {
        addIssue(
          "error",
          "DUPLICATE_SCHEMA_MIGRATION",
          path,
          `Duplicate migration version ${migration.version} for "${migration.tableName}".`,
        );
      }
      versions.add(migration.version);
    }
  }

  const sessionIds = new Set<string>();
  for (const path of listJsonFiles(join(paths.historyDir, "sessions"))) {
    const session = readJson<JsonObject>(path, addIssue);
    if (!session) continue;
    counts.sessions++;
    const id = session.id;
    if (!isNonEmptyString(id)) {
      addIssue("error", "INVALID_SESSION", path, "Session is missing id.");
      continue;
    }
    if (sessionIds.has(id)) {
      addIssue(
        "error",
        "DUPLICATE_SESSION",
        path,
        `Duplicate session id "${id}".`,
      );
    }
    sessionIds.add(id);
  }

  const messageIds = new Set<number>();
  for (const path of listJsonLineFiles(join(paths.historyDir, "messages"))) {
    const messages = readJsonLines<StoredMessage>(path, addIssue);
    for (const message of messages) {
      counts.messages++;
      if (messageIds.has(message.id)) {
        addIssue(
          "error",
          "DUPLICATE_MESSAGE",
          path,
          `Duplicate message id ${message.id}.`,
        );
      }
      messageIds.add(message.id);
      if (!sessionIds.has(message.sessionId)) {
        addIssue(
          "error",
          "MESSAGE_SESSION_MISSING",
          path,
          `Message ${message.id} references missing session "${message.sessionId}".`,
        );
      }
    }
  }

  for (const path of listJsonLineFiles(join(paths.historyDir, "usage"))) {
    const rows = readJsonLines<TurnUsage>(path, addIssue);
    for (const usage of rows) {
      counts.usageRecords++;
      if (!sessionIds.has(usage.sessionId)) {
        addIssue(
          "error",
          "USAGE_SESSION_MISSING",
          path,
          `Usage record "${usage.turnId}" references missing session "${usage.sessionId}".`,
        );
      }
    }
  }

  const changesetIds = new Set<string>();
  for (const path of listJsonFiles(join(paths.historyDir, "changesets"))) {
    const changeset = readJson<Changeset>(path, addIssue);
    if (!changeset) continue;
    counts.changesets++;
    if (!isNonEmptyString(changeset.id)) {
      addIssue("error", "INVALID_CHANGESET", path, "Changeset is missing id.");
      continue;
    }
    if (changesetIds.has(changeset.id)) {
      addIssue(
        "error",
        "DUPLICATE_CHANGESET",
        path,
        `Duplicate changeset id "${changeset.id}".`,
      );
    }
    changesetIds.add(changeset.id);
    if (changeset.sessionId && !sessionIds.has(changeset.sessionId)) {
      addIssue(
        "error",
        "CHANGESET_SESSION_MISSING",
        path,
        `Changeset "${changeset.id}" references missing session "${changeset.sessionId}".`,
      );
    }
    for (
      const id of [
        ...(changeset.planMessageIds ?? []),
        ...(changeset.workMessageIds ?? []),
        ...(changeset.approvalMessageId ? [changeset.approvalMessageId] : []),
      ]
    ) {
      if (!messageIds.has(id)) {
        addIssue(
          "error",
          "CHANGESET_MESSAGE_MISSING",
          path,
          `Changeset "${changeset.id}" references missing message ${id}.`,
        );
      }
    }
  }

  const changelogIds = new Set<number>();
  for (const record of readChangelogRecords(paths.historyDir, addIssue)) {
    counts.changelogRecords++;
    const { path, value } = record;
    if (changelogIds.has(value.id)) {
      addIssue(
        "error",
        "DUPLICATE_CHANGELOG",
        path,
        `Duplicate changelog id ${value.id}.`,
      );
    }
    changelogIds.add(value.id);
    const sessionId = value.context?.sessionId;
    if (sessionId && !sessionIds.has(sessionId)) {
      addIssue(
        "error",
        "CHANGELOG_SESSION_MISSING",
        path,
        `Changelog ${value.id} references missing session "${sessionId}".`,
      );
    }
    const changesetId = value.context?.changesetId ?? value.changesetId;
    if (changesetId && !changesetIds.has(changesetId)) {
      addIssue(
        "error",
        "CHANGELOG_CHANGESET_MISSING",
        path,
        `Changelog ${value.id} references missing changeset "${changesetId}".`,
      );
    }
    if (!isNonEmptyString(value.key) || !isNonEmptyString(value.category)) {
      addIssue(
        "error",
        "INVALID_CHANGELOG",
        path,
        `Changelog ${value.id} is missing category or key.`,
      );
    }
  }

  if (existsSync(join(projectDir, ".git")) && sync.dataIgnoredByGit === false) {
    addIssue(
      "warning",
      "DATA_NOT_GIT_IGNORED",
      paths.dataDir,
      "Local project data is not ignored by Git.",
    );
  }

  const restoreDiagnostics = await diagnoseDynamicSchemaRestore(projectDir, db);
  if (
    restoreDiagnostics.declaredTables.length > 0 &&
    restoreDiagnostics.missingTables.length > 0 &&
    !restoreDiagnostics.fixtureAvailable
  ) {
    const dataState = restoreDiagnostics.dataDirExists
      ? "local data is incomplete"
      : "no local data directory";
    const restoreAction = restoreDiagnostics.dataDirExists
      ? "Tide will recreate missing empty tables on open."
      : "Tide will recreate empty tables on open.";
    const fixtureAction = restoreDiagnostics.dataDirExists
      ? "Restored missing dynamic tables will be empty until rows are imported from fixtures/."
      : "Restored dynamic tables will be empty until rows are imported from fixtures/.";
    addIssue(
      "warning",
      "DYNAMIC_SCHEMA_LOCAL_DATA_MISSING",
      restoreDiagnostics.dataDirExists ? paths.dataDir : paths.schemaDir,
      `This project has committed schema definitions but ${dataState}. ${restoreAction} ${fixtureAction}`,
    );
  }

  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return { ok: errors.length === 0, errors, warnings, counts, sync };
}

function listJsonFiles(dir: string): string[] {
  return listFiles(dir, ".json");
}

function listJsonLineFiles(dir: string): string[] {
  return listFiles(dir, ".jsonl");
}

function listFiles(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(path, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) out.push(path);
  }
  return out.sort();
}

function readJson<T>(
  path: string,
  addIssue: (
    severity: DoctorSeverity,
    code: string,
    path: string,
    message: string,
  ) => void,
): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (err) {
    addIssue(
      "error",
      "INVALID_JSON",
      path,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function readJsonLines<T>(
  path: string,
  addIssue: (
    severity: DoctorSeverity,
    code: string,
    path: string,
    message: string,
  ) => void,
): T[] {
  try {
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return [];
    return raw.split("\n").flatMap((line, index) => {
      try {
        return [JSON.parse(line) as T];
      } catch (err) {
        addIssue(
          "error",
          "INVALID_JSONL",
          path,
          `Line ${index + 1}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return [];
      }
    });
  } catch (err) {
    addIssue(
      "error",
      "READ_ERROR",
      path,
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

function readChangelogRecords(
  historyDir: string,
  addIssue: (
    severity: DoctorSeverity,
    code: string,
    path: string,
    message: string,
  ) => void,
): Array<{ path: string; value: FileChangeRecord }> {
  const records: Array<{ path: string; value: FileChangeRecord }> = [];
  const recordsDir = join(historyDir, "changelog", "records");
  for (const path of listJsonFiles(recordsDir)) {
    const value = readJson<FileChangeRecord>(path, addIssue);
    if (value) records.push({ path, value });
  }
  const legacyPath = join(historyDir, "changelog.jsonl");
  if (existsSync(legacyPath)) {
    for (const value of readJsonLines<FileChangeRecord>(legacyPath, addIssue)) {
      records.push({ path: legacyPath, value });
    }
  }
  return records;
}

function latestActiveMigrationDropsTable(
  migrations: MigrationEntry[],
  tableName: string,
): boolean {
  const latest = migrations
    .filter((migration) =>
      migration.tableName === tableName && migration.rolledBackAt === null
    )
    .toSorted((a, b) => a.version - b.version)
    .at(-1);
  return latest ? isDropTableSql(latest.sql, tableName) : false;
}

function isDropTableSql(sql: string, tableName: string): boolean {
  const quotedName = `"${tableName.replaceAll('"', '""')}"`;
  const patterns = [
    `DROP TABLE ${quotedName}`,
    `DROP TABLE IF EXISTS ${quotedName}`,
    `DROP TABLE ${tableName}`,
    `DROP TABLE IF EXISTS ${tableName}`,
  ];
  const normalized = sql.trim().replace(/;$/, "").replace(/\s+/g, " ")
    .toUpperCase();
  return patterns.some((pattern) => pattern.toUpperCase() === normalized);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function gitIgnoresPath(projectDir: string, path: string): boolean | null {
  if (!existsSync(join(projectDir, ".git"))) return null;
  try {
    const command = new Deno.Command("git", {
      args: ["-C", projectDir, "check-ignore", "--quiet", path],
      stdout: "null",
      stderr: "null",
    });
    const status = command.outputSync();
    if (status.code === 0) return true;
    if (status.code === 1) return false;
    return null;
  } catch {
    return null;
  }
}
