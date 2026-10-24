import { assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import { join } from "node:path";
import { buildNodeFiles } from "../core/build.ts";
import { type ExportFile } from "../core/export.ts";
import { Kernel } from "../core/registries.ts";
import { withKernel } from "./export-fixtures.ts";
import {
  NO_COMMITTED_NODE_LOCK_DETAIL,
  PACKAGE_LOCKFILE_PATH,
  readCommittedNodeLock,
  verifyNodeDependencyLock,
} from "./production-node-lock.ts";
import { LOCKFILE_PATH, readCommittedLock } from "./production-lock.ts";
import {
  NODE_TOOLCHAIN_ABSENT_DETAIL,
  TARGET_DENO_SOURCE,
  TARGET_NODE,
  TARGET_NOT_SELECTED_DETAIL,
} from "./production-build.ts";
import {
  DEFAULT_REFRESH_TARGETS,
  refreshDenoLock,
  refreshLocks,
  refreshNodeLock,
} from "./production-lock-refresh.ts";

// Milestone 7, Slice 7.1 (docs/production-output-hardening-plan.md): the lock
// REFRESH producer is the network-allowed mirror image of the 6.x lock gates. It
// regenerates the committed deno.lock / package-lock.json OUTSIDE the build path
// and proves each is frozen-valid. These tests exercise the producer↔gate
// round-trip per target, the two-pass exact-mirror convergence (fork #2), adopted-
// lock replacement (fork #4), idempotency, and the target/toolchain skip semantics.
// The network-touching tests mirror production-node-lock_test.ts's real-npm setup.

// A minimal, type-correct app: one Hono handler behind a route, so its generated
// package.json pins hono / @hono/node-server / @electric-sql/pglite.
function populateApp(kernel: Kernel): void {
  kernel.handlers.register(
    "alpha",
    'import type { Context } from "hono";\n' +
      'function alpha(c: Context) { return c.text("alpha"); }',
    () => new Response(),
  );
  kernel.routes.register("GET", "/alpha", "alpha", { summary: "alpha" });
}

const OPTS = { projectName: "Test App", projectVersion: "1.0.0" };

async function withProjectDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "lockrefresh-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// Stub the kernel's package listing with synthetic user deps, then RESTORE it —
// `kernel.runtime` is a shared singleton (see build_test.ts's withStubbedPackages).
async function withStubbedPackages(
  kernel: Kernel,
  entries: Array<{ name: string; specifier: string }>,
  fn: () => Promise<void>,
): Promise<void> {
  const runtime = kernel.runtime as unknown as {
    listPackages: (kernel: Kernel) => Array<
      { name: string; specifier: string; installedAt: string }
    >;
  };
  const original = runtime.listPackages;
  runtime.listPackages = () =>
    entries.map((e) => ({ ...e, installedAt: "2026-01-01T00:00:00.000Z" }));
  try {
    await fn();
  } finally {
    runtime.listPackages = original;
  }
}

// The Node artifact the gate validates against, plus a committed lock appended.
function nodeArtifactWithLock(
  kernel: Kernel,
  lock: string,
): Promise<ExportFile[]> {
  return buildNodeFiles(kernel, OPTS.projectName, OPTS.projectVersion).then(
    (files) => [...files, { path: PACKAGE_LOCKFILE_PATH, content: lock }],
  );
}

// --- Node producer ↔ gate round-trip + idempotency (fork #1) -------------------

Deno.test({
  name:
    "refreshNodeLock: produces a committed package-lock.json the gate validates, idempotently",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateApp(kernel);
      await withProjectDir(async (dir) => {
        // No committed lock to start (the common generated-app path).
        assertEquals(readCommittedNodeLock(dir), undefined);

        const res = await refreshNodeLock(kernel, dir, OPTS);
        assertEquals(res.ok, true);
        if (!res.ok) throw new Error(res.error.message);
        assertEquals(res.data.lockfile, PACKAGE_LOCKFILE_PATH);
        assertEquals(res.data.packageCount >= 3, true);

        // It was written to <projectDir>, and re-validates through the real gate.
        const written = readCommittedNodeLock(dir);
        assertEquals(typeof written, "string");
        const gate = await verifyNodeDependencyLock(
          await nodeArtifactWithLock(kernel, written!),
          dir,
        );
        assertEquals(gate.ok && gate.data.verified, true);

        // Idempotent: a second refresh writes byte-identical bytes.
        const res2 = await refreshNodeLock(kernel, dir, OPTS);
        assertEquals(res2.ok, true);
        assertEquals(readCommittedNodeLock(dir), written);
      });
    });
  },
});

// --- Two-pass exact-mirror convergence (fork #2) ------------------------------

Deno.test({
  name:
    "refreshNodeLock: two-pass makes the lock's root-manifest mirror EXACT for a ranged user dep",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateApp(kernel);
      await withProjectDir(async (dir) => {
        await withStubbedPackages(
          kernel,
          [{ name: "is-odd", specifier: "npm:is-odd@3" }],
          async () => {
            const res = await refreshNodeLock(kernel, dir, OPTS);
            assertEquals(res.ok, true);
            if (!res.ok) throw new Error(res.error.message);

            const lock = JSON.parse(readCommittedNodeLock(dir)!) as {
              packages: Record<
                string,
                { dependencies?: Record<string, string> }
              >;
            };
            const mirror = lock.packages[""]?.dependencies?.["is-odd"];
            // Before the two-pass the mirror would be the range "3"; the second
            // pass (6.3 exact-pin fed back) makes it an exact x.y.z version.
            assertMatch(mirror ?? "", /^\d+\.\d+\.\d+$/);
          },
        );
      });
    });
  },
});

// --- Adopted-project replacement (fork #4) ------------------------------------

Deno.test({
  name:
    "refreshNodeLock: replaces an adopted lock that would fail the gate with one that passes",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateApp(kernel);
      await withProjectDir(async (dir) => {
        // An adopted lock captured for a DIFFERENT package.json (no framework deps)
        // — node_dependency_lock would reject it (the 6.2 adopted-vs-generated
        // twist). Seed it, then refresh.
        const adopted = JSON.stringify(
          { name: "other", lockfileVersion: 3, packages: { "": {} } },
          null,
          2,
        );
        Deno.writeTextFileSync(join(dir, PACKAGE_LOCKFILE_PATH), adopted);

        const res = await refreshNodeLock(kernel, dir, OPTS);
        assertEquals(res.ok, true);

        const replaced = readCommittedNodeLock(dir)!;
        assertEquals(replaced !== adopted, true); // actually replaced
        const gate = await verifyNodeDependencyLock(
          await nodeArtifactWithLock(kernel, replaced),
          dir,
        );
        assertEquals(gate.ok && gate.data.verified, true);
      });
    });
  },
});

// --- Deno producer ↔ gate round-trip (fork #3) --------------------------------

Deno.test({
  name:
    "refreshDenoLock: produces a committed deno.lock the gate validates offline",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateApp(kernel);
      await withProjectDir(async (dir) => {
        assertEquals(readCommittedLock(dir), undefined);

        const res = await refreshDenoLock(kernel, dir, OPTS);
        assertEquals(res.ok, true);
        if (!res.ok) throw new Error(res.error.message);
        assertEquals(res.data.lockfile, LOCKFILE_PATH);
        assertEquals(res.data.packageCount >= 1, true);

        // Written and byte-idempotent on a second refresh.
        const written = readCommittedLock(dir);
        assertEquals(typeof written, "string");
        const res2 = await refreshDenoLock(kernel, dir, OPTS);
        assertEquals(res2.ok, true);
        assertEquals(readCommittedLock(dir), written);
      });
    });
  },
});

// --- refreshLocks orchestration: both targets (fork #4 end-to-end) ------------

Deno.test({
  name: "refreshLocks: refreshes both selected targets and reports ok",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateApp(kernel);
      await withProjectDir(async (dir) => {
        const report = await refreshLocks(kernel, dir, OPTS);
        assertEquals(report.ok, true);
        const deno = report.targets.find((t) =>
          t.target === TARGET_DENO_SOURCE
        );
        const node = report.targets.find((t) => t.target === TARGET_NODE);
        assertEquals(deno?.status, "refreshed");
        assertEquals(node?.status, "refreshed");
        assertStringIncludes(deno!.detail, LOCKFILE_PATH);
        assertStringIncludes(node!.detail, PACKAGE_LOCKFILE_PATH);
        assertEquals(typeof readCommittedLock(dir), "string");
        assertEquals(typeof readCommittedNodeLock(dir), "string");
      });
    });
  },
});

// --- Skip semantics: no network needed ----------------------------------------

Deno.test("refreshLocks: an unselected target skips WITHOUT consulting the toolchain probe", async () => {
  await withKernel(async (kernel) => {
    populateApp(kernel);
    await withProjectDir(async (dir) => {
      // Empty selection → both skipped "target not selected"; the probe must never
      // be called (selection is checked first), so a throwing probe proves it.
      const report = await refreshLocks(
        kernel,
        dir,
        OPTS,
        new Set(),
        () => {
          throw new Error("probe must not be called for an unselected target");
        },
      );
      assertEquals(report.ok, true);
      for (const t of report.targets) {
        assertEquals(t.status, "skipped");
        assertEquals(t.detail, TARGET_NOT_SELECTED_DETAIL);
      }
      // Nothing was written.
      assertEquals(readCommittedLock(dir), undefined);
      assertEquals(readCommittedNodeLock(dir), undefined);
    });
  });
});

Deno.test("refreshLocks: a selected Node target with an absent toolchain skips cleanly, not fails", async () => {
  await withKernel(async (kernel) => {
    populateApp(kernel);
    await withProjectDir(async (dir) => {
      // Only Node selected, with an injected absent-toolchain probe → Node skips
      // "no toolchain", deno-source skips "not selected"; no network at all.
      const report = await refreshLocks(
        kernel,
        dir,
        OPTS,
        new Set([TARGET_NODE]),
        () => Promise.resolve(false),
      );
      assertEquals(report.ok, true); // a clean skip is not a failure
      const node = report.targets.find((t) => t.target === TARGET_NODE);
      const deno = report.targets.find((t) => t.target === TARGET_DENO_SOURCE);
      assertEquals(node?.status, "skipped");
      assertEquals(node?.detail, NODE_TOOLCHAIN_ABSENT_DETAIL);
      assertEquals(deno?.status, "skipped");
      assertEquals(deno?.detail, TARGET_NOT_SELECTED_DETAIL);
      assertEquals(readCommittedNodeLock(dir), undefined);
    });
  });
});

// The default target set names both refreshable targets (a guard against a
// silent divergence between the producer default and the gate target identity).
Deno.test("DEFAULT_REFRESH_TARGETS is exactly {deno-source, node}", () => {
  assertEquals(
    [...DEFAULT_REFRESH_TARGETS].toSorted(),
    [TARGET_DENO_SOURCE, TARGET_NODE].toSorted(),
  );
  // The no-committed-lock detail is re-exported through the gate module the
  // producer's skip semantics mirror.
  assertEquals(typeof NO_COMMITTED_NODE_LOCK_DETAIL, "string");
});
