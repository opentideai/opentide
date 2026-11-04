import { readEnv } from "./process-env.ts";
import { mkdirSync } from "node:fs";
import { acquireProjectLock, type ProjectLock } from "./project-lock.ts";
import { removeServerToken } from "./server-token.ts";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import { type AppServer, createAppServer } from "./app-server.ts";
import { DevServerManager } from "./dev-server.ts";
import { CommandRunner } from "./command-runner.ts";
import { registerDefaultViews } from "./dev-views.ts";
import {
  getProjectPaths,
  openProject,
  type ProjectEntry,
  readProjectPreviewPort,
  resolvePreviewPort,
} from "./project-manager.ts";
import {
  loadBranchSnapshots,
  loadKernelState,
  saveBranchSnapshots,
  saveKernelState,
} from "./persistence.ts";
import { createBackup, saveBackup } from "./backup.ts";
import { forgetBackupClock } from "./backup-cadence.ts";
import {
  APP_SERVER_PORT,
  getKernelSettings,
  OPENTIDE_DB_URL_ENV,
} from "./config.ts";
import { setUnpricedModelWarnHandler } from "./usage.ts";
import { type DoctorIssue, doctorProject } from "./project-doctor.ts";
import { runProjectInitHooks } from "./project-hooks.ts";
import type { CompositionContext } from "./composition.ts";

// Thrown when another process already has the project open. Carries the Result
// error so a caller can surface the code and suggestion verbatim rather than
// re-deriving them from a message string.
export class ProjectLockedError extends Error {
  readonly code = "PROJECT_ALREADY_OPEN" as const;
  constructor(readonly detail: { message: string; suggestion?: string }) {
    super(detail.message);
    this.name = "ProjectLockedError";
  }
}

// The entrypoint holding the lock, for the refusal message the NEXT process
// shows. Derived from argv0 so each runtime task names itself without threading
// a parameter through every caller.
function projectLockProcessName(): string {
  const main = Deno.mainModule;
  if (main.includes("mcp-main")) return "the MCP server";
  if (main.includes("lsp-main")) return "the LSP server";
  if (main.includes("cli.ts")) return "the opentide CLI";
  return "the kernel";
}

export interface ProjectContext {
  entry: ProjectEntry;
  kernel: Kernel;
  db: Database;
  appServer: AppServer;
  // Source-backed dev server (project import, Slice 3). Present for every loaded
  // project but inert until started; only ever spawns for a source-backed project
  // (mode gating lives in resolveDevRunConfig). Torn down on unload so a switched-
  // away or shut-down project never leaves an orphaned child.
  devServer: DevServerManager;
  // Runs the imported project's own discovered commands (test/build/lint/…) one at
  // a time, streamed into the kernel log (project import, Slice 6). Inert until a
  // command is run; only ever executes commands from the codebase graph's allow-list
  // (resolveProjectCommand is mode-gated). Torn down on unload so a switched-away or
  // shut-down project never leaves an orphaned test/build child.
  commandRunner: CommandRunner;
  rebuild: () => void;
  // The single-writer guard held for as long as this project is open. Null for an
  // external Postgres, which does its own concurrency control, and absent in test
  // contexts built by hand — loadProject is the only production construction site
  // and always sets it. Released on unload; the OS releases it anyway if the
  // process dies first.
  lock?: ProjectLock | null;
  backupOnUnload?: boolean;
  unloadPromise?: Promise<void>;
}

export interface LoadProjectOptions {
  appPort?: number;
  // The assembled upper-layer seams for this project's Kernel. Omitted ⇒ the
  // Kernel gets coreOnlyComposition() (no verification/agent).
  composition?: CompositionContext;
}

export async function loadProject(
  projectPath: string,
  opts: LoadProjectOptions = {},
): Promise<ProjectContext> {
  const entry = openProject(projectPath);
  const paths = getProjectPaths(entry.path);

  // Before the database is touched. PGlite is an in-process Postgres, so a second
  // process opening this directory would run a second Postgres over the same
  // files and destroy them — refusing here is the only thing standing between a
  // double-open and a corrupt project. Skipped for an external Postgres, which
  // does its own concurrency control and is not a directory we own.
  const dbUrl = readEnv(OPENTIDE_DB_URL_ENV);
  const lock = dbUrl ? null : (() => {
    const acquired = acquireProjectLock(entry.path, projectLockProcessName());
    if (!acquired.ok) throw new ProjectLockedError(acquired.error);
    return acquired.data;
  })();

  // EVERY failure from here to the end of the load must release the lock. Not
  // just the database open: a project that throws while restoring state would
  // otherwise stay locked for the life of the process, and the user would see
  // "already open" for a project that is not open at all.
  try {
    return await loadProjectLocked(entry, paths, dbUrl, lock, opts);
  } catch (err) {
    lock?.release();
    throw err;
  }
}

async function loadProjectLocked(
  entry: ProjectEntry,
  paths: ReturnType<typeof getProjectPaths>,
  dbUrl: string | undefined,
  lock: ProjectLock | null,
  opts: LoadProjectOptions,
): Promise<ProjectContext> {
  const db = await Database.create(
    dbUrl
      ? {
        driver: "postgres",
        connectionString: dbUrl,
        schemaDir: paths.schemaDir,
      }
      : {
        driver: "pglite",
        dataDir: paths.dataDir,
        schemaDir: paths.schemaDir,
      },
  );
  console.log(`  Database ready (${dbUrl ? "postgres" : paths.dataDir})`);

  const kernel = new Kernel(db, {
    historyDir: paths.historyDir,
    composition: opts.composition,
  });
  kernel.projectDir = entry.path;
  // Private sessions written before they had their own directory move there
  // now, under the lock, before anything can commit the history.
  const relocated = await kernel.sessions.relocatePrivateSessions();
  if (relocated > 0) {
    console.log(
      `  Moved ${relocated} private session(s) out of shared history`,
    );
  }
  // A model models.dev doesn't price is recorded unpriced; say so in the log.
  setUnpricedModelWarnHandler((message, metadata) =>
    kernel.log.log("warn", "system", message, { metadata })
  );
  const logLoadWarnings = kernel.log.loadFromFile(paths.logsCache);
  if (logLoadWarnings.length > 0) {
    console.warn(`  Log restore warnings:`);
    for (const warning of logLoadWarnings) console.warn(`    ${warning}`);
  }
  kernel.env.load(entry.path);
  kernel.secrets.load(entry.path);
  await registerDefaultViews(kernel);

  // Precedence (locked decision #1 / A2): a fixed manifest previewPort wins even
  // over an explicit --app-port flag; otherwise the flag (defaulting to
  // APP_SERVER_PORT, as before); otherwise auto. A1's createAppServer still
  // falls back to a free port if the resolved fixed port is taken.
  const appPort = resolvePreviewPort(
    readProjectPreviewPort(entry.path),
    opts.appPort ?? APP_SERVER_PORT,
  );
  const appServer = createAppServer(kernel, appPort);
  kernel.appPort = appServer.port;
  const devServer = new DevServerManager(kernel, appServer, entry.path);
  const commandRunner = new CommandRunner(kernel, entry.path);
  const rebuild = () => {
    appServer.rebuild();
    kernel.appPort = appServer.port;
    kernel.appRevision++;
  };

  const { errors } = await loadKernelState(kernel, paths.stateDir, rebuild);
  kernel.appPort = appServer.port;

  await kernel.audits.loadFromDb();
  // Upper layers (e.g. verification's ledger seeding) run their project-load
  // work here without project-loader importing them (OpenTide §3.3).
  await runProjectInitHooks(kernel);
  // A4 (Stream A): with live entities restored, run the boot-time survival
  // observation pass — one appended SurvivalObservation per entity that has an
  // episode, keyed by entityUid (best-effort; guarded internally).
  kernel.observeSurvival();
  loadBranchSnapshots(kernel, paths.branchSnapshots);
  if (errors.length > 0) {
    console.warn(`  State restore warnings:`);
    for (const e of errors) console.warn(`    ${e}`);
    await warnProjectDoctorReport(entry.path, db);
  }
  console.log(`  Project "${entry.name}" loaded`);

  return {
    entry,
    kernel,
    db,
    appServer,
    devServer,
    commandRunner,
    rebuild,
    lock,
    backupOnUnload: true,
  };
}

async function warnProjectDoctorReport(
  projectDir: string,
  db: Database,
): Promise<void> {
  try {
    const report = await doctorProject(projectDir, db);
    if (report.errors.length === 0 && report.warnings.length === 0) {
      console.warn("  Project doctor found no state or history issues.");
      return;
    }

    console.warn(
      `  Project doctor found ${report.errors.length} error${
        report.errors.length === 1 ? "" : "s"
      } and ${report.warnings.length} warning${
        report.warnings.length === 1 ? "" : "s"
      }:`,
    );
    for (const issue of [...report.errors, ...report.warnings]) {
      console.warn(`    ${formatDoctorIssue(issue)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`  Project doctor failed: ${message}`);
  }
}

function formatDoctorIssue(issue: DoctorIssue): string {
  return `${issue.severity.toUpperCase()} ${issue.code}: ${issue.message} (${issue.path})`;
}

export async function unloadProject(ctx: ProjectContext): Promise<void> {
  if (ctx.unloadPromise) return await ctx.unloadPromise;
  ctx.unloadPromise = unloadProjectOnce(ctx);
  return await ctx.unloadPromise;
}

async function unloadProjectOnce(ctx: ProjectContext): Promise<void> {
  const paths = getProjectPaths(ctx.entry.path);
  ctx.kernel.log.save();
  saveKernelState(ctx.kernel, paths.stateDir);
  saveBranchSnapshots(ctx.kernel, paths.branchSnapshots);

  // Children first, and BEFORE the checkpoint below — they are the last things that
  // can still put a write through the database, and a checkpoint only means anything
  // if nothing writes after it. Kill any source-backed dev-server child (and its
  // descendants) BEFORE the app server goes away, so a project switch / kernel
  // shutdown never orphans it. Same for a long-running command (test/build) still
  // executing on unload.
  await ctx.commandRunner.shutdown();
  await ctx.devServer.shutdown();
  await ctx.appServer.shutdown();

  // The data directory becomes openable HERE, not at close() — and this runs before
  // the backup rather than after it because the backup is the slowest thing on this
  // path (it reads every row and writes a dump that is megabytes on a real project)
  // and shutdown is exactly when the process is most likely to be killed part-way.
  // Checkpointing first means a kill during the dump costs the dump, not the project;
  // the alternative ordering cost this repo's own users four corrupt data directories.
  await ctx.db.checkpoint();

  try {
    const settings = getKernelSettings();
    if (ctx.backupOnUnload !== false && settings.maxDbBackups > 0) {
      mkdirSync(paths.backups, { recursive: true });
      const backup = await createBackup(ctx.kernel, ctx.kernel.db, "shutdown");
      saveBackup(backup, paths.backups, settings.maxDbBackups);
      const snapshots = backup.metadata.branchSnapshotCount ?? 0;
      const snapshotText = snapshots > 0
        ? `, ${snapshots} branch snapshot${snapshots === 1 ? "" : "s"}`
        : "";
      console.log(
        `  Backup saved (project state${snapshotText}, ${backup.metadata.tableCount} tables, ${backup.metadata.rowCount} rows)`,
      );
    }
  } catch { /* best-effort — don't block shutdown */ }

  // A reload of the same directory in this process starts with a clean clock, so the
  // first mutating call of the next session takes its own pre-session backup rather
  // than inheriting this one's timestamp.
  forgetBackupClock(ctx.entry.path);

  await ctx.db.close();
  // Whoever holds the lock owns the token file, so it goes before the lock does.
  // A token outliving its server would point a bridge at a dead port.
  removeServerToken(ctx.entry.path);
  // AFTER the database is closed, never before: the lock's job is to keep a
  // second process out while anything here is still writing, and the database is
  // the last writer. Released explicitly so a project switch frees it without
  // waiting for the process to exit.
  ctx.lock?.release();
  console.log(`  Project "${ctx.entry.name}" saved & closed`);
}
