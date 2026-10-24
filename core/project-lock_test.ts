import { assert, assertEquals } from "@std/assert";
import {
  acquireProjectLock,
  PROJECT_LOCK_FILE,
  readLockHolder,
} from "./project-lock.ts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProject } from "./project-manager.ts";
import {
  loadProject,
  ProjectLockedError,
  unloadProject,
} from "./project-loader.ts";
import { testComposition } from "../cli/test-composition.ts";
import { isolateHome } from "./test-home_test.ts";

isolateHome();

async function withTempProject(
  fn: (dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "genie-projlock-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

Deno.test("acquireProjectLock: takes the lock and records who holds it", async () => {
  await withTempProject((dir) => {
    const result = acquireProjectLock(dir, "the kernel");
    assert(result.ok);
    try {
      const holder = readLockHolder(dir);
      assert(holder);
      assertEquals(holder.pid, Deno.pid);
      assertEquals(holder.process, "the kernel");
      assert(existsSync(join(dir, ".opentide", PROJECT_LOCK_FILE)));
    } finally {
      result.data.release();
    }
  });
});

Deno.test("acquireProjectLock: advertise adds role and port to the record", async () => {
  await withTempProject((dir) => {
    const result = acquireProjectLock(dir, "the kernel");
    assert(result.ok);
    try {
      result.data.advertise({ role: "serve", controlPort: 4321 });
      const holder = readLockHolder(dir);
      assertEquals(holder?.pid, Deno.pid);
      assertEquals(holder?.process, "the kernel");
      assertEquals(holder?.role, "serve");
      assertEquals(holder?.controlPort, 4321);
    } finally {
      result.data.release();
    }
  });
});

Deno.test("acquireProjectLock: creates .opentide when the project has none yet", async () => {
  await withTempProject((dir) => {
    assert(!existsSync(join(dir, ".opentide")));
    const result = acquireProjectLock(dir);
    assert(result.ok);
    result.data.release();
    assert(existsSync(join(dir, ".opentide")));
  });
});

Deno.test("acquireProjectLock: releasing allows a re-acquire", async () => {
  await withTempProject((dir) => {
    const first = acquireProjectLock(dir);
    assert(first.ok);
    first.data.release();

    const second = acquireProjectLock(dir);
    assert(second.ok, "a released lock must be takeable again");
    second.data.release();
  });
});

Deno.test("acquireProjectLock: release is idempotent", async () => {
  await withTempProject((dir) => {
    const result = acquireProjectLock(dir);
    assert(result.ok);
    result.data.release();
    // A double release happens for real: an explicit release plus a finally, or
    // an unload path that runs twice. It must not throw on a closed descriptor.
    result.data.release();
    result.data.release();
  });
});

Deno.test("readLockHolder: a missing or malformed lock file reads as no holder", async () => {
  await withTempProject((dir) => {
    assertEquals(readLockHolder(dir), null);
    const path = join(dir, ".opentide", PROJECT_LOCK_FILE);
    acquireProjectLock(dir).ok && rmSync(path, { force: true });
    writeFileSync(path, "not json at all");
    assertEquals(readLockHolder(dir), null);
    writeFileSync(path, '{"startedAt":"now"}'); // no pid
    assertEquals(readLockHolder(dir), null);
  });
});

// --- the property that matters: a second PROCESS is excluded ----------------
// An in-process re-acquire cannot prove this. POSIX advisory locks are held per
// file description, and a second open in the SAME process may well succeed — so
// testing exclusion without a real second process would assert nothing.

const CONTENDER = `
const { acquireProjectLock } = await import(Deno.args[1]);
const result = acquireProjectLock(Deno.args[0], "the contender");
console.log(JSON.stringify(
  result.ok
    ? { acquired: true }
    : { acquired: false, code: result.error.code, message: result.error.message },
));
if (result.ok) result.data.release();
`;

async function contend(projectDir: string): Promise<{
  acquired: boolean;
  code?: string;
  message?: string;
}> {
  const script = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(script, CONTENDER);
  try {
    const modulePath = new URL("./project-lock.ts", import.meta.url).href;
    const { stdout } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--no-lock", "-A", script, projectDir, modulePath],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return JSON.parse(new TextDecoder().decode(stdout).trim());
  } finally {
    await Deno.remove(script).catch(() => {});
  }
}

Deno.test({
  name: "a second process is REFUSED while the lock is held",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // This is the whole point of the module: two processes on one PGlite data
    // directory run two Postgres instances over the same files and destroy them.
    await withTempProject(async (dir) => {
      const held = acquireProjectLock(dir, "the kernel");
      assert(held.ok);
      try {
        const result = await contend(dir);
        assertEquals(result.acquired, false);
        assertEquals(result.code, "PROJECT_ALREADY_OPEN");
        // The refusal must name the holder, or the user has no idea what to stop.
        assert(
          result.message?.includes(String(Deno.pid)),
          `expected the holding pid in: ${result.message}`,
        );
        assert(result.message?.includes("the kernel"));
      } finally {
        held.data.release();
      }
    });
  },
});

Deno.test({
  name: "a second process succeeds once the lock is released",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withTempProject(async (dir) => {
      const held = acquireProjectLock(dir);
      assert(held.ok);
      held.data.release();
      assertEquals((await contend(dir)).acquired, true);
    });
  },
});

Deno.test({
  name:
    "a lock left behind by a DEAD process is not stale — the OS released it",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // The reason this uses an OS advisory lock instead of a pid file. A crashed
    // holder leaves its lock FILE on disk, but the lock itself dies with the
    // process, so there is no staleness to detect and nothing to clean up. A pid
    // file would need a liveness check here — which is exactly the check that
    // PGlite's own postmaster.pid cannot support, since it records the sentinel
    // pid -42 rather than any real process.
    await withTempProject(async (dir) => {
      const script = await Deno.makeTempFile({ suffix: ".ts" });
      const modulePath = new URL("./project-lock.ts", import.meta.url).href;
      await Deno.writeTextFile(
        script,
        `const { acquireProjectLock } = await import(Deno.args[1]);
         acquireProjectLock(Deno.args[0], "the doomed one");
         console.log("held");
         await new Promise((r) => setTimeout(r, 60000));`,
      );
      const child = new Deno.Command(Deno.execPath(), {
        args: ["run", "--no-lock", "-A", script, dir, modulePath],
        stdout: "piped",
        stderr: "null",
      }).spawn();

      // Wait for it to actually hold the lock before killing it.
      const reader = child.stdout.getReader();
      await reader.read();
      reader.releaseLock();
      assertEquals((await contend(dir)).acquired, false, "held while alive");

      child.kill("SIGKILL");
      await child.status;
      await child.stdout.cancel().catch(() => {});
      await Deno.remove(script).catch(() => {});

      // The lock file still exists, but the lock does not.
      assert(existsSync(join(dir, ".opentide", PROJECT_LOCK_FILE)));
      assertEquals(
        (await contend(dir)).acquired,
        true,
        "a killed holder must not leave the project permanently locked",
      );
    });
  },
});

// --- end to end, through loadProject ----------------------------------------

Deno.test({
  name:
    "loadProject refuses a project that is already open, and frees it on unload",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // The bug in full: PGlite is in-process, so a second loadProject on one data
    // directory used to run a second Postgres over the same files. The lock is
    // taken before the database is opened, which is the only point at which
    // refusing is still cheap.
    const parent = mkdtempSync(join(tmpdir(), "genie-projlock-e2e-"));
    try {
      const entry = createProject(parent, "Lock Demo");
      const first = await loadProject(entry.path, {
        appPort: 0,
        composition: testComposition(),
      });
      try {
        await loadProject(entry.path, {
          appPort: 0,
          composition: testComposition(),
        });
        throw new Error("the second open should have been refused");
      } catch (err) {
        assert(err instanceof ProjectLockedError, `got: ${err}`);
        assertEquals(err.code, "PROJECT_ALREADY_OPEN");
        assert(err.message.includes(String(Deno.pid)));
      } finally {
        await unloadProject(first);
      }

      // Unload must hand the project back, or a project switch would leave it
      // locked until the process exits.
      const again = await loadProject(entry.path, {
        appPort: 0,
        composition: testComposition(),
      });
      await unloadProject(again);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
});

Deno.test({
  name: "a load that fails partway releases the lock",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Without this, a project that throws while restoring state stays locked for
    // the life of the process and reports "already open" when it is not open at
    // all. Provoked with no composition, which makes kernel.audits throw.
    const parent = mkdtempSync(join(tmpdir(), "genie-projlock-fail-"));
    try {
      const entry = createProject(parent, "Fail Demo");
      let threw = false;
      try {
        await loadProject(entry.path, { appPort: 0 });
      } catch {
        threw = true;
      }
      assert(threw, "expected the composition-less load to fail");

      const ok = await loadProject(entry.path, {
        appPort: 0,
        composition: testComposition(),
      });
      await unloadProject(ok);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  },
});
