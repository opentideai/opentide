import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  DENO_TOOLCHAIN_UNAVAILABLE,
  resolveDenoToolchain,
} from "./deno-toolchain.ts";
import {
  lockEntrypointSource,
  lockKeyCandidates,
  missingSpecifiers,
  PROJECT_LOCKFILE,
  syncProjectLock,
} from "./app-lock.ts";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import { testComposition } from "../cli/test-composition.ts";

// `await fn(dir)`, not `return fn(dir)`: with the latter the try block exits as
// soon as the promise is created, so the finally deletes the directory while the
// test body is still using it.
async function withTempProject(
  fn: (dir: string) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "genie-applock-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- missingSpecifiers -------------------------------------------------------

Deno.test("missingSpecifiers: everything is missing when there is no lock", () => {
  assertEquals(
    missingSpecifiers(undefined, ["npm:marked@18", "npm:is-odd@3"]),
    ["npm:marked@18", "npm:is-odd@3"],
  );
});

Deno.test("missingSpecifiers: a pinned specifier is not missing", () => {
  const lock = '{"specifiers":{"npm:marked@18":"18.0.7"}}';
  assertEquals(missingSpecifiers(lock, ["npm:marked@18"]), []);
});

Deno.test("missingSpecifiers: matches the quoted specifier, not a prefix of it", () => {
  // "npm:marked@1" must NOT be considered pinned by an "npm:marked@18" entry —
  // the quotes are what make this a whole-token test instead of a prefix test.
  const lock = '{"specifiers":{"npm:marked@18":"18.0.7"}}';
  assertEquals(missingSpecifiers(lock, ["npm:marked@1"]), ["npm:marked@1"]);
});

Deno.test("missingSpecifiers: reports only the ones absent", () => {
  const lock = '{"specifiers":{"npm:marked@18":"18.0.7"}}';
  assertEquals(
    missingSpecifiers(lock, ["npm:marked@18", "npm:is-odd@3"]),
    ["npm:is-odd@3"],
  );
});

Deno.test("missingSpecifiers: de-duplicates its input", () => {
  assertEquals(
    missingSpecifiers(undefined, ["npm:marked@18", "npm:marked@18"]),
    ["npm:marked@18"],
  );
});

// --- lockEntrypointSource ----------------------------------------------------

Deno.test("lockEntrypointSource: one import per specifier, sorted and de-duped", () => {
  assertEquals(
    lockEntrypointSource(["npm:b@1", "npm:a@1", "npm:b@1"]),
    'import "npm:a@1";\nimport "npm:b@1";\n',
  );
});

Deno.test("lockEntrypointSource: specifiers are JSON-quoted, not interpolated raw", () => {
  // A specifier is agent-supplied text reaching a generated module. Quoting it
  // properly is what stops a crafted name from closing the string and becoming
  // code in a file we are about to hand to Deno.
  const hostile = 'npm:evil";Deno.exit(1);//@1';
  const source = lockEntrypointSource([hostile]);
  // One statement, and the specifier survives a round-trip — which is only true
  // if the quote was escaped rather than closing the string early.
  assertEquals(source.split("\n").filter(Boolean).length, 1);
  const quoted = source.trim().slice("import ".length, -1);
  assertEquals(JSON.parse(quoted), hostile);
});

// --- syncProjectLock ---------------------------------------------------------

Deno.test("syncProjectLock: no-ops without spawning when every specifier is pinned", async () => {
  await withTempProject(async (dir) => {
    writeFileSync(
      join(dir, PROJECT_LOCKFILE),
      '{"version":"5","specifiers":{"npm:marked@18":"18.0.7"}}',
    );
    const before = readFileSync(join(dir, PROJECT_LOCKFILE), "utf-8");
    const result = await syncProjectLock(dir, ["npm:marked@18"]);
    assert(result.ok);
    assertEquals(result.data.upToDate, true);
    assertEquals(result.data.added, []);
    // Untouched: the cheap path must not rewrite the file.
    assertEquals(readFileSync(join(dir, PROJECT_LOCKFILE), "utf-8"), before);
  });
});

Deno.test("syncProjectLock: an empty specifier list is a no-op", async () => {
  await withTempProject(async (dir) => {
    const result = await syncProjectLock(dir, []);
    assert(result.ok);
    assertEquals(result.data.upToDate, true);
  });
});

// A compiled desktop build has no `deno` to run, and that must degrade to a
// missing lock RECORD rather than a failed install — the package is already live
// in memory by the time this runs. Before the toolchain seam existed this path
// reached a bare `Deno.Command("deno")` and reported its spawn error, which named
// neither the cause nor the consequence.
Deno.test("syncProjectLock: no toolchain is unavailable, not a failed install", async () => {
  await withTempProject(async (dir) => {
    const result = await syncProjectLock(
      dir,
      ["npm:marked@18"],
      undefined,
      () => ({
        ok: false,
        error: {
          code: DENO_TOOLCHAIN_UNAVAILABLE,
          message: "No Deno toolchain found. This kernel is a compiled binary.",
          suggestion: "Install Deno.",
        },
      }),
    );
    assert(!result.ok);
    assertEquals(result.error.code, "LOCK_SYNC_UNAVAILABLE");
    // The reason the resolver gave, not a spawn error.
    assertStringIncludes(result.error.message, "compiled binary");
    // And the consequence, so the log line says the install still stands.
    assertStringIncludes(
      result.error.suggestion ?? "",
      "The package is installed and usable",
    );
    // Nothing was staged or written on the way out.
    assertEquals(existsSync(join(dir, PROJECT_LOCKFILE)), false);
  });
});

// The pinned-already fast path must not even ask for a toolchain: a project whose
// lock is current opens fine on a box with no deno.
Deno.test("syncProjectLock: an up-to-date lock never probes for a toolchain", async () => {
  await withTempProject(async (dir) => {
    writeFileSync(
      join(dir, PROJECT_LOCKFILE),
      '{"version":"5","specifiers":{"npm:marked@18":"18.0.7"}}',
    );
    let probed = false;
    const result = await syncProjectLock(
      dir,
      ["npm:marked@18"],
      undefined,
      () => {
        probed = true;
        return resolveDenoToolchain();
      },
    );
    assert(result.ok);
    assertEquals(probed, false);
  });
});

Deno.test({
  name:
    "syncProjectLock: writes the project lock and leaves the repo lock alone",
  // Resolves a real package from npm (or the local Deno cache).
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const repoLockBefore = readFileSync("deno.lock", "utf-8");
    await withTempProject(async (dir) => {
      const result = await syncProjectLock(dir, ["npm:is-odd@3.0.1"]);
      assert(result.ok, `sync failed: ${!result.ok && result.error.message}`);
      assertEquals(result.data.upToDate, false);
      assertEquals(result.data.added, ["npm:is-odd@3.0.1"]);

      const appLock = readFileSync(join(dir, PROJECT_LOCKFILE), "utf-8");
      assert(appLock.includes("npm:is-odd@3.0.1"), "app lock must pin it");
    });
    // The whole point: the kernel repo's lock is not where app deps land.
    assertEquals(
      readFileSync("deno.lock", "utf-8"),
      repoLockBefore,
      "syncing an app dependency must not touch this repo's lockfile",
    );
  },
});

Deno.test({
  name:
    "syncProjectLock: MERGES into an existing lock rather than replacing it",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // A source-backed project's deno.lock is the user's own file describing
    // their own code. Clobbering it to hold only Genie-installed packages would
    // destroy real data, so this is the property that matters most here.
    await withTempProject(async (dir) => {
      const first = await syncProjectLock(dir, ["npm:is-odd@3.0.1"]);
      assert(first.ok);
      const second = await syncProjectLock(dir, [
        "npm:is-odd@3.0.1",
        "npm:is-even@1.0.0",
      ]);
      assert(second.ok, `sync failed: ${!second.ok && second.error.message}`);
      assertEquals(second.data.added, ["npm:is-even@1.0.0"]);

      const lock = readFileSync(join(dir, PROJECT_LOCKFILE), "utf-8");
      assert(
        lock.includes("npm:is-odd@3.0.1"),
        "the pre-existing pin survived",
      );
      assert(lock.includes("npm:is-even@1.0.0"), "the new pin was added");
    });
  },
});

Deno.test({
  name: "syncProjectLock: an unresolvable package fails without throwing",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withTempProject(async (dir) => {
      const result = await syncProjectLock(dir, [
        "npm:genie-package-that-does-not-exist@9.9.9",
      ]);
      assert(
        !result.ok,
        "a bad specifier must surface as a Result, not a throw",
      );
      assertEquals(result.error.code, "LOCK_SYNC_FAILED");
      // The caller treats this as non-fatal, so the message has to say the
      // install itself is fine.
      assert(result.error.suggestion?.includes("installed and usable"));
    });
  },
});

// --- end to end, through the real runtime adapter ---------------------------

Deno.test({
  name: "install_package pins into the APP lock, never the kernel repo's",
  // Resolves a real package and shells out to `deno cache`.
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // The regression this whole module exists for: a dynamic import resolves
    // against the PROCESS's lock, so an app's dependency is recorded in the
    // kernel repo as well as — now — the app's own lock.
    //
    // This test performs a REAL npm import, so it writes into whatever lock this
    // test process owns, which is this repo's. That is the unfixed half of the
    // problem (see docs/dependencies.md): it cannot be prevented in-process, and
    // `--no-lock` is not the answer because deno.json leaves several deps
    // unpinned — dropping the lock floats @electric-sql/pglite to whatever npm
    // serves today, which is a different database engine. So the test restores
    // the lock instead of pretending it was never touched.
    const repoLockBefore = readFileSync("deno.lock", "utf-8");
    const dir = mkdtempSync(join(tmpdir(), "genie-applock-e2e-"));
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testComposition() });
    kernel.projectDir = dir;
    try {
      const entry = await kernel.runtime.installPackage!(
        kernel,
        "is-odd",
        "3.0.1",
      );
      // The package is genuinely live, not merely pinned.
      assertEquals(entry.specifier, "npm:is-odd@3.0.1");
      assertEquals(typeof kernel.packages.get("is-odd"), "object");

      assert(
        readFileSync(join(dir, PROJECT_LOCKFILE), "utf-8").includes(
          "npm:is-odd@3.0.1",
        ),
        "the app's own lock must pin what the app installed",
      );
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
      // Undo this test's own pollution so a suite run leaves the tree clean.
      writeFileSync("deno.lock", repoLockBefore);
    }
  },
});

Deno.test({
  name: "installing without a project directory is a silent no-op",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Launcher mode and in-memory tests have nowhere to write a lock. That is
    // not a failure, and it must not make the install one.
    const repoLockBefore = readFileSync("deno.lock", "utf-8");
    const db = await Database.create({ driver: "pglite" });
    const kernel = new Kernel(db, { composition: testComposition() });
    assertEquals(kernel.projectDir, null);
    try {
      const entry = await kernel.runtime.installPackage!(
        kernel,
        "is-odd",
        "3.0.1",
      );
      assertEquals(entry.specifier, "npm:is-odd@3.0.1");
    } finally {
      await db.close();
      writeFileSync("deno.lock", repoLockBefore);
    }
  },
});

// --- unpinned specifiers ----------------------------------------------------
// install_package produces a bare "npm:<name>" when the agent omits a version,
// and Deno records that as "npm:<name>@*". Speed Read has exactly one of these
// (linkedom), which is how this was caught: without the @* candidate the package
// reads as missing on every check and the sync spawns a subprocess every load.

Deno.test("lockKeyCandidates: an unpinned specifier also matches its @* form", () => {
  assertEquals(lockKeyCandidates("npm:linkedom"), [
    "npm:linkedom",
    "npm:linkedom@*",
  ]);
});

Deno.test("lockKeyCandidates: a pinned specifier matches only itself", () => {
  assertEquals(lockKeyCandidates("npm:marked@18.0.9"), ["npm:marked@18.0.9"]);
});

Deno.test("lockKeyCandidates: a scoped name's @ is not mistaken for a version", () => {
  // "npm:@mozilla/readability" is UNPINNED despite containing an `@`.
  assertEquals(lockKeyCandidates("npm:@mozilla/readability"), [
    "npm:@mozilla/readability",
    "npm:@mozilla/readability@*",
  ]);
  assertEquals(lockKeyCandidates("npm:@mozilla/readability@0.6.0"), [
    "npm:@mozilla/readability@0.6.0",
  ]);
});

Deno.test("missingSpecifiers: an unpinned package pinned as @* is NOT missing", () => {
  // The exact shape of Speed Read's three packages against the lock Deno wrote.
  const lock = JSON.stringify({
    specifiers: {
      "npm:linkedom@*": "0.18.13",
      "npm:marked@18.0.9": "18.0.9",
      "npm:@mozilla/readability@0.6.0": "0.6.0",
    },
  });
  assertEquals(
    missingSpecifiers(lock, [
      "npm:@mozilla/readability@0.6.0",
      "npm:linkedom",
      "npm:marked@18.0.9",
    ]),
    [],
    "a fully-synced project must not re-spawn deno cache on every load",
  );
});
