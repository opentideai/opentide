import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import { type ExportFile } from "../core/export.ts";
import { buildNodeFiles, writeExportFiles } from "../core/build.ts";
import { Kernel } from "../core/registries.ts";
import { withKernel } from "./export-fixtures.ts";
import {
  NO_COMMITTED_NODE_LOCK_DETAIL,
  NODE_DEPENDENCY_LOCK_INVALID,
  EXPORT_NODE_DEPENDENCY_LOCK_FAILED,
  PACKAGE_LOCKFILE_PATH,
  readCommittedNodeLock,
  verifyNodeDependencyLock,
} from "./production-node-lock.ts";

// Milestone 6, Slice 6.2 (docs/production-output-hardening-plan.md): the
// node_dependency_lock gate proves a committed package-lock.json is FROZEN-valid
// for the exported Node artifact's generated package.json, validated OFFLINE with
// npm's dry-run frozen-install semantics. These tests exercise the gate in
// isolation — a passing lock (generated to match the graph), a missing lock (clean
// skip), a malformed lock (fast offline pre-check failure), and a stale lock
// (frozen mismatch) — each on real bytes, no orchestrator.
//
// A valid lock is produced the only way a real one ever is: OUT of band, by
// resolving the generated package.json once (`npm install --package-lock-only`).
// The gate then only VALIDATES it — never generates it — which is the whole point
// of the slice.

// A minimal, type-correct app: one Hono handler behind a route. Its Node artifact's
// package.json pins hono / @hono/node-server / @electric-sql/pglite, so its lock is
// small and stable.
function populateApp(kernel: Kernel): void {
  kernel.handlers.register(
    "alpha",
    'import type { Context } from "hono";\n' +
      'function alpha(c: Context) { return c.text("alpha"); }',
    () => new Response(),
  );
  kernel.routes.register("GET", "/alpha", "alpha", { summary: "alpha" });
}

async function withProjectDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "nodelock-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// Build the Node artifact for a kernel (the same producer the gate uses).
function buildApp(kernel: Kernel): Promise<ExportFile[]> {
  return buildNodeFiles(kernel, "Test App", "1.0.0");
}

// Generate a package-lock.json that EXACTLY matches the Node artifact's generated
// package.json, the same way a project author would: write the package.json alone,
// run `npm install --package-lock-only` to resolve the tree, read the produced lock
// back. Network is allowed here (this stands in for the out-of-band refresh); the
// gate itself runs offline.
async function generateMatchingLock(
  nodeFiles: ExportFile[],
  projectDir: string,
): Promise<string> {
  const packageJson = nodeFiles.find((f) => f.path === "package.json");
  if (!packageJson) throw new Error("package.json missing from Node artifact");
  const scratch = join(projectDir, "dist", ".tmp-nodelockgen");
  rmSync(scratch, { recursive: true, force: true });
  try {
    writeExportFiles(scratch, [packageJson]);
    const out = await new Deno.Command("npm", {
      args: [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      cwd: scratch,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!out.success) {
      throw new Error(
        `lock generation failed: ${new TextDecoder().decode(out.stderr)}`,
      );
    }
    return readFileSync(join(scratch, PACKAGE_LOCKFILE_PATH), "utf-8");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- readCommittedNodeLock ----------------------------------------------------

Deno.test("readCommittedNodeLock returns the file's bytes when present, undefined otherwise", async () => {
  await withProjectDir(async (dir) => {
    // No package-lock.json yet → undefined, never throws.
    assertEquals(readCommittedNodeLock(dir), undefined);
    // Write one → its exact bytes come back.
    const contents = '{ "lockfileVersion": 3 }\n';
    Deno.writeTextFileSync(join(dir, PACKAGE_LOCKFILE_PATH), contents);
    assertEquals(readCommittedNodeLock(dir), contents);
  });
});

// --- Missing lock → clean skip ------------------------------------------------

Deno.test("verifyNodeDependencyLock: no committed package-lock.json → clean skip (not a failure)", async () => {
  await withKernel(async (kernel) => {
    populateApp(kernel);
    await withProjectDir(async (dir) => {
      const nodeFiles = await buildApp(kernel); // lock-free Node artifact
      const result = await verifyNodeDependencyLock(nodeFiles, dir);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.data.verified, false);
        if (!result.data.verified) {
          assertEquals(result.data.reason, NO_COMMITTED_NODE_LOCK_DETAIL);
        }
      }
    });
  });
});

// --- Malformed lock → fast offline INVALID ------------------------------------

Deno.test("verifyNodeDependencyLock: malformed package-lock.json → NODE_DEPENDENCY_LOCK_INVALID (no spawn)", async () => {
  await withKernel(async (kernel) => {
    populateApp(kernel);
    await withProjectDir(async (dir) => {
      const nodeFiles = await buildApp(kernel);
      nodeFiles.push({ path: PACKAGE_LOCKFILE_PATH, content: "{ not valid json ]" });
      const result = await verifyNodeDependencyLock(nodeFiles, dir);
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.code, NODE_DEPENDENCY_LOCK_INVALID);
      }
    });
  });
});

Deno.test("verifyNodeDependencyLock: valid JSON but not a lockfile (no lockfileVersion) → NODE_DEPENDENCY_LOCK_INVALID", async () => {
  await withKernel(async (kernel) => {
    populateApp(kernel);
    await withProjectDir(async (dir) => {
      const nodeFiles = await buildApp(kernel);
      nodeFiles.push({ path: PACKAGE_LOCKFILE_PATH, content: '{ "packages": {} }' });
      const result = await verifyNodeDependencyLock(nodeFiles, dir);
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.code, NODE_DEPENDENCY_LOCK_INVALID);
      }
    });
  });
});

// --- Valid matching lock → verified (offline frozen check passes) -------------

Deno.test({
  name:
    "verifyNodeDependencyLock: a committed lock matching the generated package.json → verified",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateApp(kernel);
      await withProjectDir(async (dir) => {
        const nodeFiles = await buildApp(kernel);
        const lock = await generateMatchingLock(nodeFiles, dir);
        nodeFiles.push({ path: PACKAGE_LOCKFILE_PATH, content: lock });

        const result = await verifyNodeDependencyLock(nodeFiles, dir);
        assertEquals(result.ok, true);
        if (result.ok && result.data.verified) {
          assertEquals(result.data.lockfile, PACKAGE_LOCKFILE_PATH);
          // hono + @hono/node-server + @electric-sql/pglite are the base deps.
          assertEquals(result.data.packageCount >= 3, true);
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
    "verifyNodeDependencyLock: a stale lock (missing a required dep) → EXPORT_NODE_DEPENDENCY_LOCK_FAILED",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateApp(kernel);
      await withProjectDir(async (dir) => {
        const nodeFiles = await buildApp(kernel);
        const lock = await generateMatchingLock(nodeFiles, dir);
        // Drop hono from the committed lock → package.json still requires it, so
        // the offline frozen check must reconcile (needs the network) and fails.
        // This models an adopted lock that does not describe the generated graph.
        const parsed = JSON.parse(lock) as {
          packages?: Record<string, unknown>;
          dependencies?: Record<string, unknown>;
        };
        delete parsed.packages?.["node_modules/hono"];
        delete parsed.dependencies?.hono;
        const stale = JSON.stringify(parsed, null, 2) + "\n";
        assertEquals(stale !== lock, true); // the tamper actually applied
        nodeFiles.push({ path: PACKAGE_LOCKFILE_PATH, content: stale });

        const result = await verifyNodeDependencyLock(nodeFiles, dir);
        assertEquals(result.ok, false);
        if (!result.ok) {
          assertEquals(result.error.code, EXPORT_NODE_DEPENDENCY_LOCK_FAILED);
          assertStringIncludes(result.error.message, PACKAGE_LOCKFILE_PATH);
        }
      });
    });
  },
});
