import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { type ExportFile, exportProject } from "../core/export.ts";
import { writeExportFiles } from "../core/build.ts";
import { Kernel } from "../core/registries.ts";
import { withKernel } from "./export-fixtures.ts";
import {
  DEPENDENCY_LOCK_INVALID,
  EXPORT_DEPENDENCY_LOCK_FAILED,
  LOCKFILE_PATH,
  NO_COMMITTED_LOCK_DETAIL,
  readCommittedLock,
  verifyDependencyLock,
} from "./production-lock.ts";

// Milestone 6, Slice 6.1 (docs/production-output-hardening-plan.md): the
// dependency_lock gate proves a committed deno.lock is FROZEN-valid for the
// exported app's exact dependency graph, validated OFFLINE. These tests exercise
// the gate in isolation — a passing lock (generated to match the graph), a
// missing lock (clean skip), a malformed lock (fast offline pre-check failure),
// and a stale lock (frozen mismatch) — each on real bytes, no orchestrator.
//
// A valid lock is produced the only way a real one ever is: OUT of band, by
// resolving the exported app's graph once (`deno install`). The gate then only
// VALIDATES it — never generates it — which is the whole point of the slice.

// A minimal, type-correct app: one Hono handler behind a route. Its module graph
// is exactly hono + @electric-sql/pglite (via deps.ts), so its lock is small and
// stable.
function populateApp(kernel: Kernel): void {
  kernel.handlers.register(
    "alpha",
    'import type { Context } from "hono";\n' +
      'function alpha(c: Context) { return c.text("alpha"); }',
    () => new Response(),
  );
  kernel.routes.register("GET", "/alpha", "alpha", { summary: "alpha" });
}

async function withProjectDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "deplock-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// Generate a deno.lock that EXACTLY matches this export's graph, the same way a
// project author would: write the export (lock-free), run `deno install` to
// resolve + hash the graph, read the produced lock back. Network is allowed here
// (this stands in for the out-of-band refresh); the gate itself runs offline.
async function generateMatchingLock(
  files: ExportFile[],
  projectDir: string,
): Promise<string> {
  const scratch = join(projectDir, "dist", ".tmp-lockgen");
  rmSync(scratch, { recursive: true, force: true });
  try {
    writeExportFiles(scratch, files.filter((f) => f.path !== LOCKFILE_PATH));
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["install", "--entrypoint", "main.ts"],
      cwd: scratch,
      stdout: "piped",
      stderr: "piped",
      env: { DENO_NO_UPDATE_CHECK: "1" },
    }).output();
    if (!out.success) {
      throw new Error(
        `lock generation failed: ${new TextDecoder().decode(out.stderr)}`,
      );
    }
    return readFileSync(join(scratch, LOCKFILE_PATH), "utf-8");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// A tiny helper: export the app and return its files (lock-free by default).
async function exportApp(kernel: Kernel): Promise<ExportFile[]> {
  const { files } = await exportProject(kernel, { includeManifest: true });
  return files;
}

// --- readCommittedLock --------------------------------------------------------

Deno.test("readCommittedLock returns the file's bytes when present, undefined otherwise", async () => {
  await withProjectDir(async (dir) => {
    // No deno.lock yet → undefined, never throws.
    assertEquals(readCommittedLock(dir), undefined);
    // Write one → its exact bytes come back.
    const contents = '{ "version": "5" }\n';
    Deno.writeTextFileSync(join(dir, LOCKFILE_PATH), contents);
    assertEquals(readCommittedLock(dir), contents);
  });
});

// --- Missing lock → clean skip ------------------------------------------------

Deno.test("verifyDependencyLock: no committed deno.lock → clean skip (not a failure)", async () => {
  await withKernel(async (kernel) => {
    populateApp(kernel);
    await withProjectDir(async (dir) => {
      const files = await exportApp(kernel); // lock-free export
      const result = await verifyDependencyLock(files, dir);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data.verified, false);
        if (!result.data.verified) {
          assertEquals(result.data.reason, NO_COMMITTED_LOCK_DETAIL);
        }
      }
    });
  });
});

// --- Malformed lock → fast offline INVALID ------------------------------------

Deno.test("verifyDependencyLock: malformed deno.lock → DEPENDENCY_LOCK_INVALID (no spawn)", async () => {
  await withKernel(async (kernel) => {
    populateApp(kernel);
    await withProjectDir(async (dir) => {
      const files = await exportApp(kernel);
      files.push({ path: LOCKFILE_PATH, content: "{ not valid json ]" });
      const result = await verifyDependencyLock(files, dir);
      assertEquals(result.ok, false);
      if (!result.ok) assertEquals(result.error.code, DEPENDENCY_LOCK_INVALID);
    });
  });
});

Deno.test("verifyDependencyLock: valid JSON but not a lockfile (no version) → DEPENDENCY_LOCK_INVALID", async () => {
  await withKernel(async (kernel) => {
    populateApp(kernel);
    await withProjectDir(async (dir) => {
      const files = await exportApp(kernel);
      files.push({ path: LOCKFILE_PATH, content: '{ "specifiers": {} }' });
      const result = await verifyDependencyLock(files, dir);
      assertEquals(result.ok, false);
      if (!result.ok) assertEquals(result.error.code, DEPENDENCY_LOCK_INVALID);
    });
  });
});

// --- Valid matching lock → verified (offline frozen check passes) -------------

Deno.test({
  name:
    "verifyDependencyLock: a committed lock matching the export graph → verified",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateApp(kernel);
      await withProjectDir(async (dir) => {
        const files = await exportApp(kernel);
        const lock = await generateMatchingLock(files, dir);
        files.push({ path: LOCKFILE_PATH, content: lock });

        const result = await verifyDependencyLock(files, dir);
        assertEquals(result.ok, true);
        if (result.ok && result.data.verified) {
          assertEquals(result.data.lockfile, LOCKFILE_PATH);
          // @electric-sql/pglite is the one base specifier the Deno artifact declares;
          // the shell stopped importing Hono, so deno.json stopped naming it.
          assertEquals(result.data.packageCount >= 1, true);
        } else {
          throw new Error("expected a verified lock");
        }
      });
    });
  },
});

// --- Stale lock → frozen mismatch failure -------------------------------------

Deno.test({
  name:
    "verifyDependencyLock: a stale lock (wrong pinned version) → EXPORT_DEPENDENCY_LOCK_FAILED",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateApp(kernel);
      await withProjectDir(async (dir) => {
        const files = await exportApp(kernel);
        const lock = await generateMatchingLock(files, dir);
        // Repoint the PGlite specifier at a version the lock's package map does not
        // contain → the frozen check finds the lock out of date for the graph.
        const stale = lock.replace(
          /"npm:@electric-sql\/pglite@\*":\s*"[^"]+"/,
          '"npm:@electric-sql/pglite@*": "0.0.1"',
        );
        assertEquals(stale !== lock, true); // the tamper actually applied
        files.push({ path: LOCKFILE_PATH, content: stale });

        const result = await verifyDependencyLock(files, dir);
        assertEquals(result.ok, false);
        if (!result.ok) {
          assertEquals(result.error.code, EXPORT_DEPENDENCY_LOCK_FAILED);
          assertStringIncludes(result.error.message, LOCKFILE_PATH);
        }
      });
    });
  },
});
