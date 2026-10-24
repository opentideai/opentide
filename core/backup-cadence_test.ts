// The interval guard in backup-cadence.ts is the only thing standing between "one
// backup per ten minutes" and "a full table dump on every mutating tool call", so it
// is worth pinning directly. maxDbBackups is read from the user's real config here —
// these tests assert the cadence, not the retention.
import { assert, assertEquals } from "@std/assert";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "./db.ts";
import { Kernel } from "./registries.ts";
import { coreOnlyComposition } from "./composition.ts";
import { getProjectPaths } from "./project-manager.ts";
import {
  DB_BACKUP_INTERVAL_MS,
  DB_CHECKPOINT_INTERVAL_MS,
  getKernelSettings,
} from "./config.ts";
import {
  forgetBackupClock,
  maybePeriodicBackup,
  maybePeriodicCheckpoint,
  noteBackupTaken,
} from "./backup-cadence.ts";

const BACKUPS_ENABLED = getKernelSettings().maxDbBackups > 0;

async function withProject(
  fn: (kernel: Kernel, projectDir: string) => Promise<void>,
): Promise<void> {
  const projectDir = mkdtempSync(join(tmpdir(), "genie-backup-cadence-"));
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { composition: coreOnlyComposition() });
  try {
    await fn(kernel, projectDir);
  } finally {
    forgetBackupClock(projectDir);
    await db.close();
    rmSync(projectDir, { recursive: true, force: true });
  }
}

function backupCount(projectDir: string): number {
  const dir = getProjectPaths(projectDir).backups;
  return existsSync(dir) ? readdirSync(dir).length : 0;
}

Deno.test({
  name: "the first mutating call of a session backs up, the next one does not",
  ignore: !BACKUPS_ENABLED,
  fn: () =>
    withProject(async (kernel, projectDir) => {
      // Unseeded clock: the point is a copy of the project as it was before this
      // session touched anything.
      const first = await maybePeriodicBackup(kernel, projectDir);
      assert(first, "the first call should write a backup");
      assertEquals(backupCount(projectDir), 1);

      const second = await maybePeriodicBackup(kernel, projectDir);
      assertEquals(
        second,
        null,
        "a second call inside the interval is a no-op",
      );
      assertEquals(backupCount(projectDir), 1);
    }),
});

Deno.test({
  name: "a backup becomes due again once the interval has passed",
  ignore: !BACKUPS_ENABLED,
  fn: () =>
    withProject(async (kernel, projectDir) => {
      assert(await maybePeriodicBackup(kernel, projectDir));
      // Backdate the clock rather than wait ten minutes for it.
      noteBackupTaken(projectDir, Date.now() - DB_BACKUP_INTERVAL_MS - 1);
      assert(
        await maybePeriodicBackup(kernel, projectDir),
        "past the interval, the next mutating call backs up again",
      );
      assertEquals(backupCount(projectDir), 2);
    }),
});

Deno.test({
  name: "an explicit backup elsewhere pushes the periodic one out",
  ignore: !BACKUPS_ENABLED,
  fn: () =>
    withProject(async (kernel, projectDir) => {
      noteBackupTaken(projectDir);
      assertEquals(await maybePeriodicBackup(kernel, projectDir), null);
      assertEquals(backupCount(projectDir), 0);
    }),
});

Deno.test({
  name: "concurrent mutating calls produce one backup, not one each",
  ignore: !BACKUPS_ENABLED,
  fn: () =>
    withProject(async (kernel, projectDir) => {
      // createBackup reads every table, so the slot is claimed before the await —
      // without that, a burst of tool calls starts a dump apiece.
      const results = await Promise.all([
        maybePeriodicBackup(kernel, projectDir),
        maybePeriodicBackup(kernel, projectDir),
        maybePeriodicBackup(kernel, projectDir),
      ]);
      assertEquals(results.filter((r) => r !== null).length, 1);
      assertEquals(backupCount(projectDir), 1);
    }),
});

Deno.test({
  name: "forgetting the clock lets the next session take its own baseline",
  ignore: !BACKUPS_ENABLED,
  fn: () =>
    withProject(async (kernel, projectDir) => {
      assert(await maybePeriodicBackup(kernel, projectDir));
      assertEquals(await maybePeriodicBackup(kernel, projectDir), null);
      // What unloadProject does, so a reload in the same process does not inherit a
      // stale timestamp.
      forgetBackupClock(projectDir);
      assert(await maybePeriodicBackup(kernel, projectDir));
      assertEquals(backupCount(projectDir), 2);
    }),
});

// --- Checkpoints ---
//
// The checkpoint clock is separate from the backup clock and matters for a different
// reason: on PGlite a checkpoint is the only thing that puts writes onto the data
// directory's files, so the gap between checkpoints is what an unclean kill destroys.
// These pin the guard, not the flush — that a CHECKPOINT reaches Postgres is PGlite's
// problem, and an in-memory database has no files to check anyway.

Deno.test({
  name:
    "the first mutating call checkpoints, the next one inside the minute does not",
  fn: () =>
    withProject(async (kernel, projectDir) => {
      assert(
        await maybePeriodicCheckpoint(kernel, projectDir),
        "the first call should checkpoint",
      );
      assertEquals(
        await maybePeriodicCheckpoint(kernel, projectDir),
        false,
        "a second call inside the interval is a no-op",
      );
    }),
});

Deno.test({
  name: "a checkpoint becomes due again once the interval has passed",
  fn: () =>
    withProject(async (kernel, projectDir) => {
      const start = Date.now();
      assert(await maybePeriodicCheckpoint(kernel, projectDir, start));
      assertEquals(
        await maybePeriodicCheckpoint(
          kernel,
          projectDir,
          start + DB_CHECKPOINT_INTERVAL_MS - 1,
        ),
        false,
        "one millisecond short is still inside the interval",
      );
      assert(
        await maybePeriodicCheckpoint(
          kernel,
          projectDir,
          start + DB_CHECKPOINT_INTERVAL_MS,
        ),
        "the interval elapsing makes a checkpoint due again",
      );
    }),
});

Deno.test({
  name: "forgetting the clock resets the checkpoint interval too",
  fn: () =>
    withProject(async (kernel, projectDir) => {
      assert(await maybePeriodicCheckpoint(kernel, projectDir));
      assertEquals(await maybePeriodicCheckpoint(kernel, projectDir), false);
      // unloadProject calls this. A reload in the same process must not inherit the
      // old clock and then run a whole interval unflushed.
      forgetBackupClock(projectDir);
      assert(await maybePeriodicCheckpoint(kernel, projectDir));
    }),
});

Deno.test({
  name: "concurrent mutating calls produce one checkpoint, not one each",
  fn: () =>
    withProject(async (kernel, projectDir) => {
      const results = await Promise.all([
        maybePeriodicCheckpoint(kernel, projectDir),
        maybePeriodicCheckpoint(kernel, projectDir),
        maybePeriodicCheckpoint(kernel, projectDir),
      ]);
      assertEquals(results.filter(Boolean).length, 1);
    }),
});
