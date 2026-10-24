import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type BackupMetadata, listBackups } from "./backup.ts";
import { getProjectPaths } from "./project-manager.ts";

export interface RecoveryFileHealth {
  exists: boolean;
  jsonFiles: number;
  directories: number;
  unreadable: number;
}

export interface RecoveryDiagnostics {
  projectPath: string;
  manifest: {
    exists: boolean;
    valid: boolean;
    name?: string;
    error?: string;
  };
  data: {
    exists: boolean;
    pgVersion: boolean;
    walFiles: number;
    lockFiles: string[];
  };
  backups: BackupMetadata[];
  branchSnapshotCount: number;
  state: RecoveryFileHealth;
  history: RecoveryFileHealth;
  schemaFileCount: number;
  schemaMigrationFileCount: number;
  failedOpenError?: string;
}

function countJsonFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) count++;
  }
  return count;
}

function readHealth(dir: string): RecoveryFileHealth {
  if (!existsSync(dir)) {
    return { exists: false, jsonFiles: 0, directories: 0, unreadable: 0 };
  }
  let jsonFiles = 0;
  let directories = 0;
  let unreadable = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) directories++;
      if (entry.isFile() && entry.name.endsWith(".json")) jsonFiles++;
    }
  } catch {
    unreadable++;
  }
  return { exists: true, jsonFiles, directories, unreadable };
}

function readManifest(projectPath: string): RecoveryDiagnostics["manifest"] {
  const manifestPath = getProjectPaths(projectPath).manifest;
  if (!existsSync(manifestPath)) return { exists: false, valid: false };
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf-8"));
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      return {
        exists: true,
        valid: false,
        error: "Manifest is not a JSON object.",
      };
    }
    const name = (parsed as Record<string, unknown>).name;
    return {
      exists: true,
      valid: true,
      ...(typeof name === "string" ? { name } : {}),
    };
  } catch (err) {
    return {
      exists: true,
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readDataMarkers(
  dataDir: string,
): RecoveryDiagnostics["data"] {
  if (!existsSync(dataDir)) {
    return { exists: false, pgVersion: false, walFiles: 0, lockFiles: [] };
  }
  const lockFiles: string[] = [];
  let walFiles = 0;
  try {
    for (const entry of readdirSync(dataDir)) {
      if (
        entry === "postmaster.pid" || entry.endsWith(".lock") ||
        entry.endsWith(".pid")
      ) {
        lockFiles.push(entry);
      }
    }
  } catch {
    // Leave markers empty; the health summary still reports the data dir exists.
  }
  const walDir = join(dataDir, "pg_wal");
  try {
    if (existsSync(walDir) && statSync(walDir).isDirectory()) {
      walFiles = readdirSync(walDir).length;
    }
  } catch {
    walFiles = 0;
  }
  return {
    exists: true,
    pgVersion: existsSync(join(dataDir, "PG_VERSION")),
    walFiles,
    lockFiles,
  };
}

export async function diagnoseRecoveryProject(
  projectPath: string,
  failedOpenError?: string,
): Promise<RecoveryDiagnostics> {
  const paths = getProjectPaths(projectPath);
  const backups = listBackups(paths.backups);
  const branchSnapshotCount = countJsonFiles(paths.branchSnapshots) +
    countJsonFiles(paths.branchSnapshotsV2);
  const schemaMigrationDir = join(paths.schemaDir, "migrations");
  return {
    projectPath,
    manifest: readManifest(projectPath),
    data: readDataMarkers(paths.dataDir),
    backups,
    branchSnapshotCount,
    state: readHealth(paths.stateDir),
    history: readHealth(paths.historyDir),
    schemaFileCount: countJsonFiles(paths.schemaDir),
    schemaMigrationFileCount: countJsonFiles(schemaMigrationDir),
    ...(failedOpenError ? { failedOpenError } : {}),
  };
}

export function recoveryInitialMessage(d: RecoveryDiagnostics): string {
  const lines: string[] = [];
  const projectName = d.manifest.name ? ` "${d.manifest.name}"` : "";
  lines.push(`Recovery console for${projectName || " this project"}.`);
  if (d.failedOpenError) lines.push(`Open failed: ${d.failedOpenError}`);
  if (!d.manifest.exists) {
    lines.push("No opentide.json manifest was found.");
  } else if (!d.manifest.valid) {
    lines.push(
      `opentide.json is present but cannot be parsed: ${
        d.manifest.error ?? "invalid JSON"
      }.`,
    );
  } else {
    lines.push(
      "opentide.json is readable, so the project definition is still present.",
    );
  }
  if (!d.data.exists) {
    lines.push(
      "The data/ directory is missing; repair is unlikely to recover local database rows.",
    );
  } else if (d.data.pgVersion) {
    lines.push(
      `data/ contains a PGlite database marker, with ${d.data.walFiles} WAL file${
        d.data.walFiles === 1 ? "" : "s"
      }.`,
    );
  } else {
    lines.push(
      "data/ exists but does not look like an initialized PGlite directory.",
    );
  }
  if (d.backups.length > 0) {
    const latest = d.backups[0]!;
    lines.push(
      `Found ${d.backups.length} backup${
        d.backups.length === 1 ? "" : "s"
      }; latest has ${latest.tableCount} table${
        latest.tableCount === 1 ? "" : "s"
      } and ${latest.rowCount} row${latest.rowCount === 1 ? "" : "s"}.`,
    );
  } else {
    lines.push("No local database backups were found.");
  }
  const durableState = d.state.exists || d.history.exists ||
    d.schemaFileCount > 0;
  lines.push(
    durableState
      ? `Resetting empty should keep project files plus .opentide state/history on disk; local rows in data/ are the main risk.`
      : "No .opentide state/history was found, so an empty reset may leave only the manifest and source files.",
  );
  return lines.join("\n");
}
