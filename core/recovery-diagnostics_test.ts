import { assertEquals, assertStringIncludes } from "@std/assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BackupData, saveBackup } from "./backup.ts";
import { getProjectPaths } from "./project-manager.ts";
import {
  diagnoseRecoveryProject,
  recoveryInitialMessage,
} from "./recovery-diagnostics.ts";
import type { PersistedState } from "./persistence.ts";
import { TEST_TMP_DIR } from "./test-home_test.ts";

function emptyState(): PersistedState {
  return {
    version: 1,
    routes: [],
    handlers: [],
    functions: [],
    configs: [],
    templates: [],
    assets: [],
    packages: [],
    devViews: [],
    devTools: [],
    tests: [],
    customAudits: [],
    types: [],
    branches: [],
  };
}

function backup(id: string): BackupData {
  return {
    metadata: {
      id,
      createdAt: "2026-01-01T00:00:00.000Z",
      trigger: "manual",
      tableCount: 1,
      rowCount: 2,
      branchSnapshotCount: 1,
      includesProjectState: true,
    },
    kernelState: emptyState(),
    tables: [{
      tableName: "widgets",
      sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT)",
      rows: [{ id: 1, name: "one" }, { id: 2, name: "two" }],
    }],
  };
}

async function withRecoveryProject(
  fn: (projectDir: string) => Promise<void>,
): Promise<void> {
  const prevHome = Deno.env.get("HOME");
  const home = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-recovery-home-",
  });
  const projectDir = await Deno.makeTempDir({
    dir: TEST_TMP_DIR,
    prefix: "genie-recovery-project-",
  });
  try {
    Deno.env.set("HOME", home);
    await fn(projectDir);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevHome);
  }
}

Deno.test("recovery diagnostics reports valid project with backups", async () => {
  await withRecoveryProject(async (projectDir) => {
    const paths = getProjectPaths(projectDir);
    writeFileSync(paths.manifest, JSON.stringify({ name: "Recover Me" }));
    mkdirSync(paths.dataDir, { recursive: true });
    writeFileSync(join(paths.dataDir, "PG_VERSION"), "15\n");
    mkdirSync(join(paths.dataDir, "pg_wal"), { recursive: true });
    writeFileSync(join(paths.dataDir, "pg_wal", "0001"), "");
    saveBackup(backup("backup_one"), paths.backups, 5);

    const diagnostics = await diagnoseRecoveryProject(projectDir, "DB failed");

    assertEquals(diagnostics.manifest, {
      exists: true,
      valid: true,
      name: "Recover Me",
    });
    assertEquals(diagnostics.data.pgVersion, true);
    assertEquals(diagnostics.data.walFiles, 1);
    assertEquals(diagnostics.backups.length, 1);
    assertEquals(diagnostics.backups[0]?.rowCount, 2);
    assertStringIncludes(recoveryInitialMessage(diagnostics), "Found 1 backup");
  });
});

Deno.test("recovery diagnostics handles no backups and missing data", async () => {
  await withRecoveryProject(async (projectDir) => {
    const paths = getProjectPaths(projectDir);
    writeFileSync(paths.manifest, JSON.stringify({ name: "No Data" }));

    const diagnostics = await diagnoseRecoveryProject(projectDir);

    assertEquals(diagnostics.data.exists, false);
    assertEquals(diagnostics.backups, []);
    assertStringIncludes(
      recoveryInitialMessage(diagnostics),
      "No local database backups were found.",
    );
  });
});

Deno.test("recovery diagnostics reports corrupt manifest", async () => {
  await withRecoveryProject(async (projectDir) => {
    const paths = getProjectPaths(projectDir);
    writeFileSync(paths.manifest, "{not json");

    const diagnostics = await diagnoseRecoveryProject(projectDir);

    assertEquals(diagnostics.manifest.exists, true);
    assertEquals(diagnostics.manifest.valid, false);
    assertStringIncludes(
      recoveryInitialMessage(diagnostics),
      "opentide.json is present but cannot be parsed",
    );
  });
});

Deno.test("recovery diagnostics counts state, history, schemas, and snapshots", async () => {
  await withRecoveryProject(async (projectDir) => {
    const paths = getProjectPaths(projectDir);
    writeFileSync(paths.manifest, JSON.stringify({ name: "Stateful" }));
    mkdirSync(paths.stateDir, { recursive: true });
    mkdirSync(paths.historyDir, { recursive: true });
    mkdirSync(paths.schemaDir, { recursive: true });
    mkdirSync(join(paths.schemaDir, "migrations"), { recursive: true });
    mkdirSync(paths.branchSnapshots, { recursive: true });
    writeFileSync(join(paths.stateDir, "routes.json"), "[]");
    writeFileSync(join(paths.historyDir, "meta.json"), "{}");
    writeFileSync(join(paths.schemaDir, "widgets.json"), "{}");
    writeFileSync(join(paths.schemaDir, "migrations", "widgets.json"), "[]");
    writeFileSync(join(paths.branchSnapshots, "snap.json"), "{}");

    const diagnostics = await diagnoseRecoveryProject(projectDir);

    assertEquals(diagnostics.state.jsonFiles, 1);
    assertEquals(diagnostics.history.jsonFiles, 1);
    assertEquals(diagnostics.schemaFileCount, 1);
    assertEquals(diagnostics.schemaMigrationFileCount, 1);
    assertEquals(diagnostics.branchSnapshotCount, 1);
  });
});
