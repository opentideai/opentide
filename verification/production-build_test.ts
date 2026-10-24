import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync, rmSync } from "node:fs";
import {
  type ExportFile,
  exportProject,
  fileBytes,
  MANIFEST_PATH,
} from "../core/export.ts";
import {
  buildNodeFiles,
  defaultBinaryCompileTarget,
  writeExportFiles,
} from "../core/build.ts";
import { Kernel } from "../core/registries.ts";
import { withKernel } from "./export-fixtures.ts";
import {
  type BuildTarget,
  EXPORT_APP_SMOKE_FAILED,
  EXPORT_BINARY_SMOKE_FAILED,
  EXPORT_DENO_SMOKE_FAILED,
  EXPORT_DEPENDENCY_LOCK_FAILED,
  EXPORT_NODE_DEPENDENCY_LOCK_FAILED,
  EXPORT_NODE_SMOKE_FAILED,
  EXPORT_ROUTE_PARITY_FAILED,
  EXPORT_TYPE_CHECK_FAILED,
  GATE_APP_SMOKE,
  GATE_BINARY_SMOKE,
  GATE_DENO_SMOKE,
  GATE_DEPENDENCY_LOCK,
  GATE_DETERMINISM,
  GATE_MANIFEST,
  GATE_NODE_DEPENDENCY_LOCK,
  GATE_NODE_SMOKE,
  GATE_ROUTE_PARITY,
  GATE_TYPE_CHECK,
  type GateOutcome,
  NODE_TOOLCHAIN_ABSENT_DETAIL,
  nodeToolchainAvailable,
  reportOk,
  ROUTE_PARITY_SINGLE_TARGET_DETAIL,
  runBinarySmokeGate,
  runDenoSmokeGate,
  runNodeSmokeGate,
  runProductionBuild,
  runTypeCheckGate,
  sequenceGates,
  skippedOutcome,
  TARGET_BINARY,
  TARGET_DENO_SOURCE,
  TARGET_NODE,
  TARGET_NOT_SELECTED_DETAIL,
} from "./production-build.ts";
import { LOCKFILE_PATH, NO_COMMITTED_LOCK_DETAIL } from "./production-lock.ts";
import {
  NO_COMMITTED_NODE_LOCK_DETAIL,
  PACKAGE_LOCKFILE_PATH,
} from "./production-node-lock.ts";

// Milestone 2 (docs/production-output-hardening-plan.md): the production-build
// orchestrator assembles the pure gates into one ordered pipeline (manifest →
// determinism → type check → app smoke) and wires the process-dependent gates —
// the export type check and the app-start / `/_health` (+ `/openapi.json`) smoke,
// each of which spawns a Deno subprocess. These tests need --allow-run/-read/-write
// (and, for the app-smoke subprocess booting the exported app, --allow-net/-env/-ffi).
//
// NOTE: the shared `populate` fixture deliberately registers untyped handler
// sources (implicit-any), so it does NOT pass `deno check`. The type-check gate
// therefore needs type-correct fixtures, defined here.

// A minimal, type-correct app: one Hono handler behind a route. Passes
// `deno check main.ts`.
function populateTypeCorrect(kernel: Kernel): void {
  kernel.handlers.register(
    "alpha",
    'import type { Context } from "hono";\n' +
      'function alpha(c: Context) { return c.text("alpha"); }',
    () => new Response(),
  );
  kernel.routes.register("GET", "/alpha", "alpha", { summary: "alpha" });
}

// A type-correct app whose handler is written against the FETCH ABI, annotated with
// the real `Request`/`Response`/`HandlerContext`. Both gates below matter: `deno
// check` proves the emitted module resolves HandlerContext out of deps.ts, and the
// smoke boot proves the exported shell's adapter closure actually calls it with a
// Request. Boot it the old way (handler handed straight to Hono) and `ctx.params`
// reads Hono's Context, which has no `params` — a TypeError per request.
function populateFetchAbi(kernel: Kernel): void {
  kernel.handlers.register(
    "fetchAlpha",
    `function fetchAlpha(req: Request, ctx: HandlerContext): Response {
  return Response.json({ path: new URL(req.url).pathname, params: ctx.params });
}`,
    () => new Response(),
  );
  kernel.routes.register("GET", "/fetch-alpha", "fetchAlpha", {
    summary: "fetchAlpha",
  });
}

// The same shape but with a genuine type error in the handler body, so
// `deno check` fails with a real TS diagnostic (not an implicit-any noise error).
function populateTypeError(kernel: Kernel): void {
  kernel.handlers.register(
    "broken",
    'import type { Context } from "hono";\n' +
      'function broken(c: Context) { const n: number = "not a number"; return c.text(String(n)); }',
    () => new Response(),
  );
  kernel.routes.register("GET", "/broken", "broken", { summary: "broken" });
}

// A type-correct app whose single route carries NO RouteSchema, so no openapi.json
// is emitted. The app still starts and serves /_health, exercising the app-smoke
// gate's "OpenAPI requirement is waived when nothing was emitted" path.
function populateNoOpenApi(kernel: Kernel): void {
  kernel.handlers.register(
    "alpha",
    'import type { Context } from "hono";\n' +
      'function alpha(c: Context) { return c.text("alpha"); }',
    () => new Response(),
  );
  // No schema argument → allRoutes.some((r) => r.schema) is false → no openapi.json.
  kernel.routes.register("GET", "/alpha", "alpha");
}

// A type-correct app that THROWS at import time. `deno check` passes (a throwing
// IIFE assigned to a typed const is valid TS with no unreachable code), so the
// manifest/determinism/type-check gates all pass — but importing the generated
// main.ts (which eagerly imports every handler) rejects, so the app-smoke gate's
// createApp() import fails. This is the app-smoke negative path.
function populateAppBoom(kernel: Kernel): void {
  kernel.handlers.register(
    "boom",
    'import type { Context } from "hono";\n' +
      'function boom(c: Context) { return c.text("boom"); }\n' +
      'const _boot: string = ((): string => { throw new Error("boom at import"); })();',
    () => new Response(),
  );
  kernel.routes.register("GET", "/boom", "boom", { summary: "boom" });
}

// A type-correct app with a safe, param-free GET route that returns a 500 on a
// bare hit. The app boots and /_health is 200 (so the health contract passes), but
// the route-smoke sub-check probes GET /five-hundred, sees a server error, and
// fails the gate — the Slice 4.2 negative path (a route that 500s ships red now,
// not green). No schema → no openapi.json, so the OpenAPI check is waived and the
// only app route probed is this one.
function populateRoute500(kernel: Kernel): void {
  kernel.handlers.register(
    "fiveHundred",
    'import type { Context } from "hono";\n' +
      'function fiveHundred(c: Context) { return c.text("boom", 500); }',
    () => new Response(),
  );
  kernel.routes.register("GET", "/five-hundred", "fiveHundred");
}

// A type-correct app whose only real surface is a mutating POST and a
// parameterized GET — both invisible to the safe-subset smoke plan until Slice
// 4.3's productionTest fixtures lift them out of the skipped set. POST /orders is
// marked safe with a body fixture and its handler returns 201; GET /orders/:id
// carries a pathParams fixture and returns 200. No route is safe-by-default here,
// so this proves the fixtures — not the default GET/HEAD rule — drive the probes.
function populateFixtureRoutes(kernel: Kernel): void {
  kernel.handlers.register(
    "createOrder",
    'import type { Context } from "hono";\n' +
      'function createOrder(c: Context) { return c.json({ id: "o1" }, 201); }',
    () => new Response(),
  );
  kernel.routes.register("POST", "/orders", "createOrder", {
    summary: "create order",
    body: { type: "object", required: ["item"] },
    responses: {
      "201": { description: "Created", schema: { type: "object" } },
    },
    productionTest: {
      safe: true,
      exampleRequest: { body: { item: "widget" } },
    },
  });

  kernel.handlers.register(
    "getOrder",
    'import type { Context } from "hono";\n' +
      'function getOrder(c: Context) { return c.json({ id: c.req.param("id") }); }',
    () => new Response(),
  );
  kernel.routes.register("GET", "/orders/:id", "getOrder", {
    summary: "get order",
    params: { id: { type: "string" } },
    responses: {
      "200": { description: "OK", schema: { type: "object" } },
    },
    productionTest: {
      exampleRequest: { pathParams: { id: "123" } },
    },
  });
}

// A route whose declared body schema the fixture VIOLATES on purpose, expecting the 400
// the exported app now answers. The smoke plan gates on a fixture being PRESENT, not on
// it being valid (verification/route-smoke-plan.ts, gate (iv) checks only
// `body !== undefined`), so this needs no new machinery — and it is the only thing that
// fires a schema-violating request at a real node process and a real compiled binary.
// The in-process preview-vs-export comparison of the same 400 is
// core/preview-export-parity_test.ts; these two prove the generated validators survive
// esbuild's transpile and `deno compile`'s embedding.
function populateRejectsBadBody(kernel: Kernel): void {
  kernel.handlers.register(
    "createOrder",
    `async function createOrder(req: Request): Promise<Response> {
  const body = await req.json() as { item: string };
  return Response.json({ item: body.item }, { status: 201 });
}`,
    () => new Response(),
  );
  kernel.routes.register("POST", "/orders", "createOrder", {
    summary: "create order",
    body: {
      type: "object",
      properties: { item: { type: "string" } },
      required: ["item"],
    },
    responses: {
      "201": { description: "Created", schema: { type: "object" } },
      "400": { description: "Validation failed", schema: { type: "object" } },
    },
    productionTest: {
      safe: true,
      // No `item`. The app must answer 400 without reaching the handler — which would
      // 500 on `body.item` being undefined if validation were skipped, so a green run
      // here cannot be an accident.
      exampleRequest: { body: { nope: 1 } },
      expectedStatus: 400,
    },
  });
}

// A mutating route the author marked safe whose handler 500s. The fixture lifts
// it into a real probe (a bare POST — no body fixture), the probe hits the 500,
// and the route-smoke sub-check maps it to EXPORT_DENO_SMOKE_FAILED — a
// safe-marked route that errors ships red, exactly like a safe GET would (Slice
// 4.2's populateRoute500 for the mutating-via-fixture case).
function populateSafePost500(kernel: Kernel): void {
  kernel.handlers.register(
    "boomOrder",
    'import type { Context } from "hono";\n' +
      'function boomOrder(c: Context) { return c.text("boom", 500); }',
    () => new Response(),
  );
  kernel.routes.register("POST", "/orders", "boomOrder", {
    productionTest: { safe: true },
  });
}

// A type-correct app whose single safe GET route branches on the RUNTIME: it
// returns {"runtime":"deno"} under the Deno source/binary export and
// {"runtime":"node"} under the transpiled Node artifact (in Node there is no global
// `Deno`, so `typeof Deno === "undefined"`; rewriteMainForNode only rewrites
// main.ts, never a handler body). The route carries productionTest.deterministicBody
// so both targets fingerprint the body, and the differing bodies make the two
// hashes disagree — the Slice-4.4 parity negative: a specifier/runtime divergence
// that each per-target contract passes (both are 200 JSON) ships RED at route_parity.
function populateRuntimeBranch(kernel: Kernel): void {
  kernel.handlers.register(
    "whichRuntime",
    'import type { Context } from "hono";\n' +
      'function whichRuntime(c: Context) { return c.json({ runtime: typeof Deno !== "undefined" ? "deno" : "node" }); }',
    () => new Response(),
  );
  kernel.routes.register("GET", "/runtime", "whichRuntime", {
    summary: "runtime",
    responses: {
      "200": { description: "OK", schema: { type: "object" } },
    },
    productionTest: { deterministicBody: true },
  });
}

// Read the sourceFingerprint straight off an export's emitted manifest.json.
function manifestFingerprint(files: ExportFile[]): string {
  const entry = files.find((f) => f.path === MANIFEST_PATH);
  if (!entry) throw new Error("manifest.json missing from artifact");
  const parsed = JSON.parse(new TextDecoder().decode(fileBytes(entry)));
  return parsed.sourceFingerprint as string;
}

function gateNames(gates: GateOutcome[]): string[] {
  return gates.map((g) => g.gate);
}

async function withProjectDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "prodbuild-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// Produce a deno.lock matching a kernel's export graph and drop it at
// <projectDir>/deno.lock, so runProductionBuild sources it as the committed lock
// (Slice 6.1). Mirrors an out-of-band `deno install`: export lock-free, resolve
// the graph, capture the lock. Used only by the committed-lock E2E cases.
async function seedCommittedLock(
  kernel: Kernel,
  projectDir: string,
): Promise<void> {
  const { files } = await exportProject(kernel);
  const scratch = join(projectDir, "dist", ".tmp-lockseed");
  rmSync(scratch, { recursive: true, force: true });
  try {
    writeExportFiles(scratch, files);
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["install", "--entrypoint", "main.ts"],
      cwd: scratch,
      stdout: "piped",
      stderr: "piped",
      env: { DENO_NO_UPDATE_CHECK: "1" },
    }).output();
    if (!out.success) {
      throw new Error(
        `lock seed failed: ${new TextDecoder().decode(out.stderr)}`,
      );
    }
    const lock = readFileSync(join(scratch, LOCKFILE_PATH), "utf-8");
    Deno.writeTextFileSync(join(projectDir, LOCKFILE_PATH), lock);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Produce a package-lock.json matching a kernel's generated Node package.json and
// drop it at <projectDir>/package-lock.json, so runProductionBuild sources it as
// the committed Node lock (Slice 6.2). Mirrors an out-of-band
// `npm install --package-lock-only` over the generated package.json (network
// allowed here; the gate runs offline). Returns the lock's path so a caller can
// tamper it. Used only by the committed-Node-lock E2E cases.
async function seedCommittedNodeLock(
  kernel: Kernel,
  projectDir: string,
): Promise<string> {
  const nodeFiles = await buildNodeFiles(kernel, "Genie App", "unversioned");
  const packageJson = nodeFiles.find((f) => f.path === "package.json");
  if (!packageJson) throw new Error("package.json missing from Node artifact");
  const scratch = join(projectDir, "dist", ".tmp-nodelockseed");
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
        `node lock seed failed: ${new TextDecoder().decode(out.stderr)}`,
      );
    }
    const lock = readFileSync(join(scratch, PACKAGE_LOCKFILE_PATH), "utf-8");
    const lockPath = join(projectDir, PACKAGE_LOCKFILE_PATH);
    Deno.writeTextFileSync(lockPath, lock);
    return lockPath;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// --- Happy path ---------------------------------------------------------------

Deno.test({
  name:
    "runProductionBuild passes the five core gates and skips both opt-in targets by default",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      // A schema-bearing route → openapi.json is emitted, so both smoke gates
      // check it.
      populateTypeCorrect(kernel);
      await withProjectDir(async (projectDir) => {
        const report = await runProductionBuild(kernel, projectDir);

        assertEquals(report.ok, true, JSON.stringify(report).slice(0, 4000));
        // The default targets (deno-source only) still run the five core gates in
        // order, then append node/binary as trailing skip rows and the trailing
        // route_parity skip (only deno-source probed → nothing to compare).
        assertEquals(gateNames(report.gates), [
          GATE_MANIFEST,
          GATE_DETERMINISM,
          GATE_TYPE_CHECK,
          GATE_DEPENDENCY_LOCK,
          GATE_APP_SMOKE,
          GATE_DENO_SMOKE,
          GATE_NODE_DEPENDENCY_LOCK,
          GATE_NODE_SMOKE,
          GATE_BINARY_SMOKE,
          GATE_ROUTE_PARITY,
        ]);
        // The report now contains skips, so the invariant is "no failed gate".
        assertEquals(report.gates.every((g) => g.status !== "failed"), true);

        // No committed deno.lock in this temp project → dependency_lock self-skips
        // (a generated app that never had a lock is not a regression).
        const lockSkip = report.gates[3]!;
        assertEquals(lockSkip.gate, GATE_DEPENDENCY_LOCK);
        assertEquals(lockSkip.status, "skipped");
        assertEquals(lockSkip.detail, NO_COMMITTED_LOCK_DETAIL);
        assertEquals(lockSkip.code, undefined);

        // The three unselected Node/binary target gates are reported as skips, not
        // omitted. node_dependency_lock precedes node_smoke.
        const nodeLockSkip = report.gates[6]!;
        assertEquals(nodeLockSkip.gate, GATE_NODE_DEPENDENCY_LOCK);
        assertEquals(nodeLockSkip.status, "skipped");
        assertEquals(nodeLockSkip.detail, TARGET_NOT_SELECTED_DETAIL);
        assertEquals(nodeLockSkip.code, undefined);
        const nodeSkip = report.gates[7]!;
        assertEquals(nodeSkip.gate, GATE_NODE_SMOKE);
        assertEquals(nodeSkip.status, "skipped");
        assertEquals(nodeSkip.detail, TARGET_NOT_SELECTED_DETAIL);
        assertEquals(nodeSkip.code, undefined);
        const binarySkip = report.gates[8]!;
        assertEquals(binarySkip.gate, GATE_BINARY_SMOKE);
        assertEquals(binarySkip.status, "skipped");
        assertEquals(binarySkip.detail, TARGET_NOT_SELECTED_DETAIL);
        assertEquals(binarySkip.code, undefined);

        // route_parity self-skips: with only deno-source probed there are fewer
        // than two targets to compare, so it is a clean skip (no code).
        const parity = report.gates[9]!;
        assertEquals(parity.gate, GATE_ROUTE_PARITY);
        assertEquals(parity.status, "skipped");
        assertEquals(parity.detail, ROUTE_PARITY_SINGLE_TARGET_DETAIL);
        assertEquals(parity.code, undefined);

        // Release candidate present only on success.
        assertEquals(report.artifact !== undefined, true);
        if (report.artifact) {
          assertEquals(report.artifact.files.length > 0, true);
          assertEquals(report.artifact.tarball.byteLength > 0, true);
          // openapi.json was emitted, so the app-smoke detail names both routes.
          const smoke = report.gates[4]!;
          assertEquals(smoke.detail.includes("/openapi.json"), true);
          // The real-process deno-smoke detail names both routes AND --version.
          const denoSmoke = report.gates[5]!;
          assertEquals(denoSmoke.detail.includes("/_health"), true);
          assertEquals(denoSmoke.detail.includes("/openapi.json"), true);
          assertEquals(denoSmoke.detail.includes("--version"), true);
          // Slice 4.2: the app's own /alpha route is probed (framework pair
          // excluded), and the coverage is surfaced in the detail.
          assertEquals(denoSmoke.detail.includes("1 route probed"), true);
          // sourceFingerprint comes from the manifest gate and equals the manifest's.
          assertEquals(
            report.sourceFingerprint,
            manifestFingerprint(report.artifact.files),
          );
        }
      });
    });
  },
});

// --- OpenAPI-absent path ------------------------------------------------------

// A type-correct kernel with no schema-bearing route emits no openapi.json; the
// app-smoke gate's /openapi.json requirement is waived and the build still passes.
Deno.test({
  name:
    "runProductionBuild passes both smoke gates without openapi.json when none is emitted",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateNoOpenApi(kernel);
      await withProjectDir(async (projectDir) => {
        const report = await runProductionBuild(kernel, projectDir);

        assertEquals(report.ok, true, JSON.stringify(report).slice(0, 4000));
        assertEquals(gateNames(report.gates), [
          GATE_MANIFEST,
          GATE_DETERMINISM,
          GATE_TYPE_CHECK,
          GATE_DEPENDENCY_LOCK,
          GATE_APP_SMOKE,
          GATE_DENO_SMOKE,
          GATE_NODE_DEPENDENCY_LOCK,
          GATE_NODE_SMOKE,
          GATE_BINARY_SMOKE,
          GATE_ROUTE_PARITY,
        ]);
        // The report now contains the trailing skips, so the invariant is
        // "no failed gate".
        assertEquals(report.gates.every((g) => g.status !== "failed"), true);

        // No committed lock → dependency_lock self-skips.
        const lockSkip = report.gates[3]!;
        assertEquals(lockSkip.gate, GATE_DEPENDENCY_LOCK);
        assertEquals(lockSkip.status, "skipped");
        assertEquals(lockSkip.detail, NO_COMMITTED_LOCK_DETAIL);

        // The three unselected Node/binary target gates are reported as skips.
        const nodeLockSkip = report.gates[6]!;
        assertEquals(nodeLockSkip.gate, GATE_NODE_DEPENDENCY_LOCK);
        assertEquals(nodeLockSkip.status, "skipped");
        assertEquals(nodeLockSkip.detail, TARGET_NOT_SELECTED_DETAIL);
        assertEquals(nodeLockSkip.code, undefined);
        const nodeSkip = report.gates[7]!;
        assertEquals(nodeSkip.gate, GATE_NODE_SMOKE);
        assertEquals(nodeSkip.status, "skipped");
        assertEquals(nodeSkip.detail, TARGET_NOT_SELECTED_DETAIL);
        assertEquals(nodeSkip.code, undefined);
        const binarySkip = report.gates[8]!;
        assertEquals(binarySkip.gate, GATE_BINARY_SMOKE);
        assertEquals(binarySkip.status, "skipped");
        assertEquals(binarySkip.detail, TARGET_NOT_SELECTED_DETAIL);
        assertEquals(binarySkip.code, undefined);
        // route_parity self-skips (only deno-source probed).
        const parity = report.gates[9]!;
        assertEquals(parity.gate, GATE_ROUTE_PARITY);
        assertEquals(parity.status, "skipped");
        assertEquals(parity.detail, ROUTE_PARITY_SINGLE_TARGET_DETAIL);

        // No openapi.json in the artifact, and both smoke details name only
        // /_health (the OpenAPI check was waived).
        assertEquals(report.artifact !== undefined, true);
        if (report.artifact) {
          assertEquals(
            report.artifact.files.some((f) => f.path === "openapi.json"),
            false,
          );
        }
        const smoke = report.gates[4]!;
        assertEquals(smoke.status, "passed");
        assertEquals(smoke.detail.includes("/openapi.json"), false);
        const denoSmoke = report.gates[5]!;
        assertEquals(denoSmoke.status, "passed");
        assertEquals(denoSmoke.detail.includes("/openapi.json"), false);
      });
    });
  },
});

// --- Committed dependency lock (Slice 6.1) ------------------------------------

// A project that ships a committed deno.lock matching its export graph passes the
// dependency_lock gate: the orchestrator sources <projectDir>/deno.lock, emits it
// into the artifact, and the gate validates it offline with a frozen check. The
// gate sits between type_check and app_smoke and reports "frozen-valid".
Deno.test({
  name:
    "runProductionBuild passes dependency_lock when the project ships a matching committed deno.lock",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateTypeCorrect(kernel);
      await withProjectDir(async (projectDir) => {
        await seedCommittedLock(kernel, projectDir);
        const report = await runProductionBuild(kernel, projectDir);

        assertEquals(report.ok, true, JSON.stringify(report).slice(0, 4000));
        // The lock gate ran (not skipped) between type_check and app_smoke.
        const lock = report.gates[3]!;
        assertEquals(lock.gate, GATE_DEPENDENCY_LOCK);
        assertEquals(lock.status, "passed");
        assertEquals(lock.detail.includes("frozen-valid"), true);
        // The committed lock is byte-covered by the manifest — it ships in the
        // artifact and appears in the manifest's file list.
        assertEquals(report.artifact !== undefined, true);
        if (report.artifact) {
          assertEquals(
            report.artifact.files.some((f) => f.path === LOCKFILE_PATH),
            true,
          );
        }
      });
    });
  },
});

// A committed lock that does NOT match the export graph fails the build and STOPS
// the pipeline, producing no release candidate. A committed deno.lock is consumed
// by BOTH `deno check` (the type-check gate honors it) and the frozen check (the
// lock gate), so a corrupt lock is rejected by whichever reaches it first — the
// integration invariant proven here is "a bad committed lock blocks the release";
// the dependency_lock gate's precise EXPORT_DEPENDENCY_LOCK_FAILED is pinned by
// production-lock_test.ts. Either way, no artifact and the tail never runs.
Deno.test({
  name: "runProductionBuild fails (and stops) on a corrupt committed deno.lock",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateTypeCorrect(kernel);
      await withProjectDir(async (projectDir) => {
        await seedCommittedLock(kernel, projectDir);
        // Repoint the PGlite specifier at a version absent from the lock's package
        // map → the lock is internally inconsistent (corrupt) for the graph. PGlite
        // is the Deno artifact's only platform dependency since the shell stopped
        // importing Hono.
        const lockPath = join(projectDir, LOCKFILE_PATH);
        const corrupt = readFileSync(lockPath, "utf-8").replace(
          /"npm:@electric-sql\/pglite@\*":\s*"[^"]+"/,
          '"npm:@electric-sql/pglite@*": "0.0.1"',
        );
        // The tamper has to actually apply, or this asserts nothing.
        assertEquals(corrupt !== readFileSync(lockPath, "utf-8"), true);
        Deno.writeTextFileSync(lockPath, corrupt);

        const report = await runProductionBuild(kernel, projectDir);

        // The build fails and ships no release candidate.
        assertEquals(report.ok, false);
        assertEquals(report.artifact, undefined);
        // A gate failed with a lock-rejecting code (the type check or the lock
        // gate — both legitimately reject a corrupt committed lock).
        const failed = report.gates.find((g) => g.status === "failed")!;
        assertEquals(
          failed.code === EXPORT_DEPENDENCY_LOCK_FAILED ||
            failed.code === EXPORT_TYPE_CHECK_FAILED,
          true,
        );
        // Stop-at-first: the later boot gates never ran.
        assertEquals(
          report.gates.some((g) => g.gate === GATE_APP_SMOKE),
          false,
        );
        assertEquals(
          report.gates.some((g) => g.gate === GATE_DENO_SMOKE),
          false,
        );
      });
    });
  },
});

// --- Per-target selection (Slice 3.5.2) ---------------------------------------

// These exercise the real per-target wiring end-to-end (a real `npm ci` boot / a
// real `deno compile`), so they carry the same sanitizeResources/Ops opt-out and
// reuse the same fixtures as the other heavy gate tests. One test proves each
// selection direction: node-selected runs node + skips binary, binary-selected
// runs binary + skips node. The default (both skipped) is covered by the migrated
// happy-path tests above, and both-selected is implied by the union of these two —
// so a separate all-heavy (node + binary together) test is deliberately omitted to
// avoid paying both a full npm ci and a full deno compile in one case for no extra
// coverage.

Deno.test({
  name:
    "runProductionBuild runs node_smoke and skips binary_smoke when only node is selected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateTypeCorrect(kernel);
      await withProjectDir(async (projectDir) => {
        const targets = new Set<BuildTarget>([TARGET_DENO_SOURCE, TARGET_NODE]);
        const report = await runProductionBuild(
          kernel,
          projectDir,
          undefined,
          targets,
        );

        assertEquals(report.ok, true, JSON.stringify(report).slice(0, 4000));
        assertEquals(gateNames(report.gates), [
          GATE_MANIFEST,
          GATE_DETERMINISM,
          GATE_TYPE_CHECK,
          GATE_DEPENDENCY_LOCK,
          GATE_APP_SMOKE,
          GATE_DENO_SMOKE,
          GATE_NODE_DEPENDENCY_LOCK,
          GATE_NODE_SMOKE,
          GATE_BINARY_SMOKE,
          GATE_ROUTE_PARITY,
        ]);
        // node was selected → its gates wire and run; binary was not → it skips.
        // No committed package-lock.json in this temp project → node_dependency_lock
        // self-skips (a Node app that never had a committed lock is not a regression).
        const nodeLock = report.gates[6]!;
        assertEquals(nodeLock.gate, GATE_NODE_DEPENDENCY_LOCK);
        assertEquals(nodeLock.status, "skipped");
        assertEquals(nodeLock.detail, NO_COMMITTED_NODE_LOCK_DETAIL);
        assertEquals(nodeLock.code, undefined);
        const node = report.gates[7]!;
        assertEquals(node.gate, GATE_NODE_SMOKE);
        assertEquals(node.status, "passed");
        const binary = report.gates[8]!;
        assertEquals(binary.status, "skipped");
        assertEquals(binary.detail, TARGET_NOT_SELECTED_DETAIL);
        // Two targets (deno-source + node) actually produced route results, so
        // route_parity RUNS (not a self-skip) and their /alpha route agrees across
        // both, so the gate passes and its detail names both compared targets.
        const parity = report.gates[9]!;
        assertEquals(parity.gate, GATE_ROUTE_PARITY);
        assertEquals(parity.status, "passed");
        assertEquals(parity.detail.includes(TARGET_DENO_SOURCE), true);
        assertEquals(parity.detail.includes(TARGET_NODE), true);
      });
    });
  },
});

Deno.test({
  name:
    "runProductionBuild runs binary_smoke and skips node_smoke when only binary is selected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateTypeCorrect(kernel);
      await withProjectDir(async (projectDir) => {
        const targets = new Set<BuildTarget>([
          TARGET_DENO_SOURCE,
          TARGET_BINARY,
        ]);
        const report = await runProductionBuild(
          kernel,
          projectDir,
          undefined,
          targets,
        );

        assertEquals(report.ok, true, JSON.stringify(report).slice(0, 4000));
        // node was not selected → both its gates skip; binary was → it runs.
        const nodeLock = report.gates[6]!;
        assertEquals(nodeLock.gate, GATE_NODE_DEPENDENCY_LOCK);
        assertEquals(nodeLock.status, "skipped");
        assertEquals(nodeLock.detail, TARGET_NOT_SELECTED_DETAIL);
        const node = report.gates[7]!;
        assertEquals(node.gate, GATE_NODE_SMOKE);
        assertEquals(node.status, "skipped");
        assertEquals(node.detail, TARGET_NOT_SELECTED_DETAIL);
        const binary = report.gates[8]!;
        assertEquals(binary.status, "passed");
        // The binary detail names the compiled host triple from the payload.
        assertEquals(
          binary.detail.includes(defaultBinaryCompileTarget()),
          true,
        );
        // deno-source + binary both produced route results → route_parity runs and
        // passes (both Deno-runtime targets, so /alpha trivially agrees), naming the
        // two compared targets in its detail.
        const parity = report.gates[9]!;
        assertEquals(parity.gate, GATE_ROUTE_PARITY);
        assertEquals(parity.status, "passed");
        assertEquals(parity.detail.includes(TARGET_DENO_SOURCE), true);
        assertEquals(parity.detail.includes(TARGET_BINARY), true);
      });
    });
  },
});

// --- Committed Node dependency lock (Slice 6.2) -------------------------------

// A project that ships a committed package-lock.json matching its generated Node
// package.json passes node_dependency_lock: the orchestrator sources
// <projectDir>/package-lock.json, threads it into the export (and thus the Node
// artifact), and the gate validates it offline with a dry-run frozen check. The
// gate sits before node_smoke and reports "frozen-valid". Real npm + node boot, so
// the heavy-test opt-outs apply.
Deno.test({
  name:
    "runProductionBuild passes node_dependency_lock when the project ships a matching committed package-lock.json",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateTypeCorrect(kernel);
      await withProjectDir(async (projectDir) => {
        await seedCommittedNodeLock(kernel, projectDir);
        const targets = new Set<BuildTarget>([TARGET_DENO_SOURCE, TARGET_NODE]);
        const report = await runProductionBuild(
          kernel,
          projectDir,
          undefined,
          targets,
        );

        assertEquals(report.ok, true, JSON.stringify(report).slice(0, 4000));
        // node_dependency_lock ran (not skipped) and passed, before node_smoke.
        const nodeLock = report.gates[6]!;
        assertEquals(nodeLock.gate, GATE_NODE_DEPENDENCY_LOCK);
        assertEquals(nodeLock.status, "passed");
        assertEquals(nodeLock.detail.includes("frozen-valid"), true);
        const nodeSmoke = report.gates[7]!;
        assertEquals(nodeSmoke.gate, GATE_NODE_SMOKE);
        assertEquals(nodeSmoke.status, "passed");
        // The committed lock ships in the export and is byte-covered by the manifest.
        assertEquals(report.artifact !== undefined, true);
        if (report.artifact) {
          assertEquals(
            report.artifact.files.some((f) => f.path === PACKAGE_LOCKFILE_PATH),
            true,
          );
        }
      });
    });
  },
});

// A committed Node lock that does NOT match the generated package.json fails the
// build and STOPS the pipeline before node_smoke, producing no release candidate.
// Unlike the deno.lock case (consumed by `deno check` too), nothing else consumes
// the Node lock, so node_dependency_lock is the sole gate that rejects it — its
// precise EXPORT_NODE_DEPENDENCY_LOCK_FAILED is what surfaces.
Deno.test({
  name:
    "runProductionBuild fails (and stops before node_smoke) on a stale committed package-lock.json",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateTypeCorrect(kernel);
      await withProjectDir(async (projectDir) => {
        const lockPath = await seedCommittedNodeLock(kernel, projectDir);
        // Drop hono from the committed lock → package.json still requires it, so the
        // offline frozen check must reconcile (needs the network) and fails.
        const parsed = JSON.parse(readFileSync(lockPath, "utf-8")) as {
          packages?: Record<string, unknown>;
          dependencies?: Record<string, unknown>;
        };
        delete parsed.packages?.["node_modules/hono"];
        delete parsed.dependencies?.hono;
        Deno.writeTextFileSync(
          lockPath,
          JSON.stringify(parsed, null, 2) + "\n",
        );

        const targets = new Set<BuildTarget>([TARGET_DENO_SOURCE, TARGET_NODE]);
        const report = await runProductionBuild(
          kernel,
          projectDir,
          undefined,
          targets,
        );

        // The build fails and ships no release candidate.
        assertEquals(report.ok, false);
        assertEquals(report.artifact, undefined);
        // node_dependency_lock is the failing gate, with its own umbrella code.
        const failed = report.gates.find((g) => g.status === "failed")!;
        assertEquals(failed.gate, GATE_NODE_DEPENDENCY_LOCK);
        assertEquals(failed.code, EXPORT_NODE_DEPENDENCY_LOCK_FAILED);
        // Stop-at-first: the more expensive node_smoke boot never ran.
        assertEquals(
          report.gates.some((g) => g.gate === GATE_NODE_SMOKE),
          false,
        );
      });
    });
  },
});

// --- User dependency pinning (Slice 6.3) -------------------------------------

// Register a synthetic user package so a build references it without a real npm
// import (mirrors app-docs_test.ts / core/build_test.ts), then RESTORE it.
// `kernel.runtime` is a shared module-level singleton, so a bare override would leak
// this package into every later test's exports in this file; save-and-restore
// contains it. The package must exist on npm for seedCommittedNodeLock's real
// `--package-lock-only`; is-number@7 is a stable, zero-dependency choice.
async function withStubbedUserPackage(
  kernel: Kernel,
  name: string,
  specifier: string,
  fn: () => Promise<void>,
): Promise<void> {
  const runtime = kernel.runtime as unknown as {
    listPackages: (kernel: Kernel) => Array<
      { name: string; specifier: string; installedAt: string }
    >;
  };
  const original = runtime.listPackages;
  runtime.listPackages = () => [{
    name,
    specifier,
    installedAt: "2026-01-01T00:00:00.000Z",
  }];
  try {
    await fn();
  } finally {
    runtime.listPackages = original;
  }
}

// A project carrying a USER package (not just the framework deps) plus a committed
// lock passes node_dependency_lock: buildNodeFiles pins the user dep to the lock's
// EXACT resolved version (Slice 6.3), so the gate now validates an exact whole-graph
// correspondence — and the offline frozen check still passes even though the lock's
// root-manifest mirror holds the original range (fork #2). Real npm + node boot, so
// the heavy-test opt-outs apply.
Deno.test({
  name:
    "runProductionBuild pins a user dep to the committed lock's exact version and passes node_dependency_lock",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateTypeCorrect(kernel);
      // A RANGE specifier: without a lock it reshapes to "^7.0.0"; with the lock it
      // pins to the exact resolved version.
      await withStubbedUserPackage(
        kernel,
        "is-number",
        "npm:is-number@^7.0.0",
        () =>
          withProjectDir(async (projectDir) => {
            // The seed builds package.json with the reshaped (unpinned) range, then
            // resolves it to a committed lock (network here; the gate runs offline).
            await seedCommittedNodeLock(kernel, projectDir);
            const lock = JSON.parse(
              readFileSync(join(projectDir, PACKAGE_LOCKFILE_PATH), "utf-8"),
            ) as { packages: Record<string, { version?: string }> };
            const resolved = lock.packages["node_modules/is-number"]?.version;
            assertEquals(typeof resolved, "string");

            const targets = new Set<BuildTarget>([
              TARGET_DENO_SOURCE,
              TARGET_NODE,
            ]);
            const report = await runProductionBuild(
              kernel,
              projectDir,
              undefined,
              targets,
            );

            assertEquals(
              report.ok,
              true,
              JSON.stringify(report).slice(0, 4000),
            );
            const nodeLock = report.gates[6]!;
            assertEquals(nodeLock.gate, GATE_NODE_DEPENDENCY_LOCK);
            assertEquals(nodeLock.status, "passed");
            assertEquals(nodeLock.detail.includes("frozen-valid"), true);
            const nodeSmoke = report.gates[7]!;
            assertEquals(nodeSmoke.gate, GATE_NODE_SMOKE);
            assertEquals(nodeSmoke.status, "passed");

            // The generated Node package.json pins the user dep to the lock's EXACT
            // resolved version — not the "^7.0.0" specifier — proving whole-graph
            // pinning.
            const nodeFiles = await buildNodeFiles(
              kernel,
              "Genie App",
              "unversioned",
              {
                packageLock: readFileSync(
                  join(projectDir, PACKAGE_LOCKFILE_PATH),
                  "utf-8",
                ),
              },
            );
            const deps = JSON.parse(
              nodeFiles.find((f) => f.path === "package.json")!.content!,
            ).dependencies;
            assertEquals(deps["is-number"], resolved);
          }),
      );
    });
  },
});

// --- Cross-target route parity (Slice 4.4) ------------------------------------

// The end-to-end proof that route_parity maps a real cross-target divergence to
// EXPORT_ROUTE_PARITY_FAILED. The runtime-branch handler answers 200 JSON on BOTH
// deno-source and node — so every per-target contract passes — but the bodies
// differ ({"runtime":"deno"} vs {"runtime":"node"}), and because the route opts into
// deterministicBody both targets fingerprint the body, so their hashes disagree and
// the trailing parity gate fails naming the route. This pays a real `npm ci` + node
// boot (node selected), so it carries the heavy-test opt-outs like the other
// per-target gate tests. This is the real proof the mismatch threads end-to-end
// without throwing; the pure comparator cases live in route-parity_test.ts.
Deno.test({
  name:
    "runProductionBuild fails route_parity when a deterministic route's body differs across targets",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateRuntimeBranch(kernel);
      await withProjectDir(async (projectDir) => {
        const targets = new Set<BuildTarget>([TARGET_DENO_SOURCE, TARGET_NODE]);
        const report = await runProductionBuild(
          kernel,
          projectDir,
          undefined,
          targets,
        );

        // The build fails, but ONLY at route_parity — every per-target gate passed
        // (the runtime branch is a valid 200 JSON response on both targets).
        assertEquals(report.ok, false);
        assertEquals(report.artifact, undefined);
        const parity = report.gates.find((g) => g.gate === GATE_ROUTE_PARITY)!;
        assertEquals(parity.status, "failed");
        assertEquals(parity.code, EXPORT_ROUTE_PARITY_FAILED);
        // The detail names the offending route so a consumer can act on it.
        assertEquals(parity.detail.includes("/runtime"), true);
        // Every gate before route_parity passed — the divergence is invisible to
        // the per-target contracts and surfaces only in the cross-target compare.
        const deno = report.gates.find((g) => g.gate === GATE_DENO_SMOKE)!;
        const node = report.gates.find((g) => g.gate === GATE_NODE_SMOKE)!;
        assertEquals(deno.status, "passed");
        assertEquals(node.status, "passed");
      });
    });
  },
});

// --- Toolchain preflight (Slice 3.5.3) ----------------------------------------

// The real probe answers true on the test box: the Node smoke tests here already
// assume node+npm on PATH, so nodeToolchainAvailable() must agree — and it must
// never throw. Light: two `--version` spawns, no gate.
Deno.test({
  name:
    "nodeToolchainAvailable returns true on a box with node+npm and never throws",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    let threw = false;
    let available = false;
    try {
      available = await nodeToolchainAvailable();
    } catch {
      threw = true;
    }
    assertEquals(threw, false);
    assertEquals(available, true);
  },
});

// The headline case: a SELECTED node target whose toolchain is absent must be
// reported as skipped ("node/npm not found on PATH"), NOT failed. The injected
// probe returns false, which short-circuits before runNodeSmokeGate ever runs — so
// this pays no real npm ci / node boot and needs no sanitizeResources/Ops opt-out.
Deno.test("runProductionBuild skips (not fails) a selected node target whose toolchain is absent", async () => {
  await withKernel(async (kernel) => {
    populateTypeCorrect(kernel);
    await withProjectDir(async (projectDir) => {
      const targets = new Set<BuildTarget>([TARGET_DENO_SOURCE, TARGET_NODE]);
      const report = await runProductionBuild(
        kernel,
        projectDir,
        undefined,
        targets,
        () => Promise.resolve(false), // toolchain absent
      );

      // A missing toolchain is a clean skip, so the whole build still passes.
      assertEquals(report.ok, true, JSON.stringify(report).slice(0, 4000));
      assertEquals(report.gates.length, 10);

      // Both Node-scoped gates were selected but the toolchain is absent → each is
      // skipped with the distinct toolchain reason and no code. node_dependency_lock
      // honors the same preflight as node_smoke (selection then probe).
      const nodeLock = report.gates[6]!;
      assertEquals(nodeLock.gate, GATE_NODE_DEPENDENCY_LOCK);
      assertEquals(nodeLock.status, "skipped");
      assertEquals(nodeLock.detail, NODE_TOOLCHAIN_ABSENT_DETAIL);
      assertEquals(nodeLock.code, undefined);
      const node = report.gates[7]!;
      assertEquals(node.gate, GATE_NODE_SMOKE);
      assertEquals(node.status, "skipped");
      assertEquals(node.detail, NODE_TOOLCHAIN_ABSENT_DETAIL);
      assertEquals(node.code, undefined);

      // binary was not selected → its own "target not selected" skip, unaffected.
      const binary = report.gates[8]!;
      assertEquals(binary.gate, GATE_BINARY_SMOKE);
      assertEquals(binary.status, "skipped");
      assertEquals(binary.detail, TARGET_NOT_SELECTED_DETAIL);

      // Node skipped (absent toolchain), so only deno-source produced results →
      // route_parity self-skips rather than comparing a single target.
      const parity = report.gates[9]!;
      assertEquals(parity.gate, GATE_ROUTE_PARITY);
      assertEquals(parity.status, "skipped");
      assertEquals(parity.detail, ROUTE_PARITY_SINGLE_TARGET_DETAIL);
    });
  });
});

// Precedence: selection is checked BEFORE the probe. An UNSELECTED node target must
// skip with "target not selected" without ever consulting the probe — proven by
// injecting a probe that throws if called. Light: no real gate runs.
//
// A separate "binary unaffected by an absent node probe" test is deliberately
// omitted: the binary step never references the probe (it is structurally
// independent), and 3.5.2's binary-selected test already proves binary runs when
// selected — re-paying a `deno compile` to assert a structural fact isn't worth it
// (same cost decision as 3.5.2's omitted all-heavy test).
Deno.test("runProductionBuild checks selection before the toolchain probe for node", async () => {
  await withKernel(async (kernel) => {
    populateTypeCorrect(kernel);
    await withProjectDir(async (projectDir) => {
      // Default targets = deno-source only, so node is UNSELECTED.
      const report = await runProductionBuild(
        kernel,
        projectDir,
        undefined,
        undefined,
        () => Promise.reject(new Error("probe must not run")),
      );

      assertEquals(report.ok, true, JSON.stringify(report).slice(0, 4000));
      // Both Node-scoped gates skip for non-selection, never consulting the
      // (throwing) probe — each checks selection FIRST. node_dependency_lock is the
      // first to face the choice, so its clean skip proves the ordering too.
      const nodeLock = report.gates[6]!;
      assertEquals(nodeLock.gate, GATE_NODE_DEPENDENCY_LOCK);
      assertEquals(nodeLock.status, "skipped");
      assertEquals(nodeLock.detail, TARGET_NOT_SELECTED_DETAIL);
      const node = report.gates[7]!;
      assertEquals(node.gate, GATE_NODE_SMOKE);
      assertEquals(node.status, "skipped");
      assertEquals(node.detail, TARGET_NOT_SELECTED_DETAIL);
    });
  });
});

// --- Type-check failure -------------------------------------------------------

Deno.test("runProductionBuild fails on the type-check gate for a kernel with a type error", async () => {
  await withKernel(async (kernel) => {
    populateTypeError(kernel);
    await withProjectDir(async (projectDir) => {
      const report = await runProductionBuild(kernel, projectDir);

      assertEquals(report.ok, false);
      // No release candidate on failure.
      assertEquals(report.artifact, undefined);

      // Gates run in order; the manifest + determinism gates precede type check
      // and both pass, so all three appear (type check is the failing tail).
      assertEquals(gateNames(report.gates), [
        GATE_MANIFEST,
        GATE_DETERMINISM,
        GATE_TYPE_CHECK,
      ]);
      // Stop-at-first: a non-type-checking app can't be imported, so the
      // dependency-lock and app-smoke gates never run and are absent from the
      // report (both come after the failing type-check).
      assertEquals(
        report.gates.some((g) => g.gate === GATE_DEPENDENCY_LOCK),
        false,
      );
      assertEquals(report.gates.some((g) => g.gate === GATE_APP_SMOKE), false);
      // The pipeline stops before the trailing target steps, so none of the node
      // (lock + smoke) or binary skip rows are appended (stop-before-target) — and
      // the trailing route_parity step never runs either (a failed target can't be
      // compared).
      assertEquals(
        report.gates.some((g) => g.gate === GATE_NODE_DEPENDENCY_LOCK),
        false,
      );
      assertEquals(report.gates.some((g) => g.gate === GATE_NODE_SMOKE), false);
      assertEquals(
        report.gates.some((g) => g.gate === GATE_BINARY_SMOKE),
        false,
      );
      assertEquals(
        report.gates.some((g) => g.gate === GATE_ROUTE_PARITY),
        false,
      );

      const manifest = report.gates[0]!;
      const determinism = report.gates[1]!;
      const typeCheck = report.gates[2]!;
      assertEquals(manifest.status, "passed");
      assertEquals(determinism.status, "passed");
      assertEquals(typeCheck.status, "failed");
      assertEquals(typeCheck.code, EXPORT_TYPE_CHECK_FAILED);
      // The detail names the offending file:line so a consumer can act on it.
      assertEquals(typeCheck.detail.includes("handlers/broken.ts"), true);

      // The fingerprint from the (passing) manifest gate is still surfaced.
      const { files } = await exportProject(kernel, {
        includeManifest: true,
        includeMigrations: true,
        includeReferenceSeeds: true,
      });
      assertEquals(report.sourceFingerprint, manifestFingerprint(files));
    });
  });
});

// --- App-smoke failure --------------------------------------------------------

// A type-correct app that throws at import time clears the manifest/determinism/
// type-check gates but fails the app-smoke gate: createApp()'s import rejects, so
// the subprocess exits non-zero and the gate maps it to EXPORT_APP_SMOKE_FAILED.
Deno.test("runProductionBuild fails on the app-smoke gate when the app fails to import", async () => {
  await withKernel(async (kernel) => {
    populateAppBoom(kernel);
    await withProjectDir(async (projectDir) => {
      const report = await runProductionBuild(kernel, projectDir);

      assertEquals(report.ok, false);
      // No release candidate on failure.
      assertEquals(report.artifact, undefined);

      // The earlier gates pass (dependency_lock self-skips — no committed lock),
      // so app-smoke is the failing tail.
      assertEquals(gateNames(report.gates), [
        GATE_MANIFEST,
        GATE_DETERMINISM,
        GATE_TYPE_CHECK,
        GATE_DEPENDENCY_LOCK,
        GATE_APP_SMOKE,
      ]);
      assertEquals(report.gates[0]!.status, "passed");
      assertEquals(report.gates[1]!.status, "passed");
      assertEquals(report.gates[2]!.status, "passed");
      assertEquals(report.gates[3]!.status, "skipped");

      const smoke = report.gates[4]!;
      assertEquals(smoke.status, "failed");
      assertEquals(smoke.code, EXPORT_APP_SMOKE_FAILED);

      // Stop-at-first: the more expensive real-process deno-smoke gate never runs
      // (app-smoke is the failing tail) and is absent from the report.
      assertEquals(report.gates.some((g) => g.gate === GATE_DENO_SMOKE), false);
      // The pipeline stops before the trailing target steps too, so none of the
      // node (lock + smoke) or binary skip rows are appended (stop-before-target),
      // and the trailing route_parity step never runs.
      assertEquals(
        report.gates.some((g) => g.gate === GATE_NODE_DEPENDENCY_LOCK),
        false,
      );
      assertEquals(report.gates.some((g) => g.gate === GATE_NODE_SMOKE), false);
      assertEquals(
        report.gates.some((g) => g.gate === GATE_BINARY_SMOKE),
        false,
      );
      assertEquals(
        report.gates.some((g) => g.gate === GATE_ROUTE_PARITY),
        false,
      );
    });
  });
});

// --- Never throws (app-smoke negative path) -----------------------------------

// The orchestrator represents an app-smoke failure as ok: false rather than
// throwing — the boom kernel exercises the real subprocess non-zero-exit path.
Deno.test("runProductionBuild does not throw on an app-smoke failure", async () => {
  await withKernel(async (kernel) => {
    populateAppBoom(kernel);
    await withProjectDir(async (projectDir) => {
      let threw = false;
      let ok = true;
      try {
        const report = await runProductionBuild(kernel, projectDir);
        ok = report.ok;
      } catch {
        threw = true;
      }
      assertEquals(threw, false);
      assertEquals(ok, false);
    });
  });
});

// --- Deno-smoke gate direct failure (never-throws) ----------------------------

// Called directly (not through the orchestrator, where app-smoke fails first and
// stop-at-first means deno-smoke never runs). The boom app throws at import, so
// the real server exits before printing "Server running on"; the gate reaps the
// child and maps the early exit to EXPORT_DENO_SMOKE_FAILED without ever throwing.
Deno.test({
  name: "runDenoSmokeGate fails (never throws) when the app crashes on boot",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateAppBoom(kernel);
      await withProjectDir(async (projectDir) => {
        let threw = false;
        let result;
        try {
          result = await runDenoSmokeGate(kernel, projectDir);
        } catch {
          threw = true;
        }
        assertEquals(threw, false);
        assertEquals(result?.ok, false);
        if (result && !result.ok) {
          assertEquals(result.error.code, EXPORT_DENO_SMOKE_FAILED);
        }
      });
    });
  },
});

// --- Deno-smoke gate advisory route-smoke failures ---------------------------

// The app boots cleanly and /_health is 200 (the health contract passes), but its
// own safe GET /five-hundred route answers 500. By default that app-authored route
// failure is diagnostic route-smoke coverage, not a boot-gate blocker.
Deno.test({
  name:
    "runDenoSmokeGate passes with a routeSmoke warning when a safe route returns 500",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateRoute500(kernel);
      await withProjectDir(async (projectDir) => {
        let threw = false;
        let result;
        try {
          result = await runDenoSmokeGate(kernel, projectDir);
        } catch {
          threw = true;
        }
        assertEquals(threw, false);
        assertEquals(result?.ok, true);
        if (result?.ok) {
          assertEquals(result.data.routeSmoke.status, "warning");
          assertEquals(result.data.routeSmoke.routesProbed, 1);
          assertEquals(result.data.routeSmoke.routesFailed, 1);
          assertEquals(
            result.data.routeSmoke.failures[0]?.detail.includes(
              "/five-hundred",
            ),
            true,
          );
        }
      });
    });
  },
});

Deno.test({
  name:
    "runDenoSmokeGate fails on routeSmoke warning when strictRouteSmoke is true",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateRoute500(kernel);
      await withProjectDir(async (projectDir) => {
        const result = await runDenoSmokeGate(kernel, projectDir, {
          strictRouteSmoke: true,
        });

        assertEquals(result.ok, false);
        if (!result.ok) {
          assertEquals(result.error.code, EXPORT_DENO_SMOKE_FAILED);
          assertEquals(result.error.message.includes("/five-hundred"), true);
        }
      });
    });
  },
});

Deno.test({
  name:
    "runProductionBuild passes by default and records routeSmoke warning details for a route 500",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateRoute500(kernel);
      await withProjectDir(async (projectDir) => {
        const report = await runProductionBuild(kernel, projectDir);

        assertEquals(report.ok, true, JSON.stringify(report).slice(0, 4000));
        assertEquals(report.artifact !== undefined, true);
        assertEquals(report.routeSmoke?.status, "warning");
        assertEquals(report.routeSmoke?.routesProbed, 1);
        assertEquals(report.routeSmoke?.routesFailed, 1);
        assertEquals(
          report.routeSmoke?.failures[0]?.target,
          TARGET_DENO_SOURCE,
        );
        assertEquals(
          report.routeSmoke?.failures[0]?.detail.includes("/five-hundred"),
          true,
        );
        const deno = report.gates.find((g) => g.gate === GATE_DENO_SMOKE)!;
        assertEquals(deno.status, "passed");
        assertEquals(
          deno.detail.includes("route smoke warning: 1 failed"),
          true,
        );
      });
    });
  },
});

Deno.test({
  name:
    "runProductionBuild fails when strictRouteSmoke is true and a route returns 500",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateRoute500(kernel);
      await withProjectDir(async (projectDir) => {
        const report = await runProductionBuild(kernel, projectDir, {
          strictRouteSmoke: true,
        });

        assertEquals(report.ok, false);
        assertEquals(report.artifact, undefined);
        const deno = report.gates.find((g) => g.gate === GATE_DENO_SMOKE)!;
        assertEquals(deno.status, "failed");
        assertEquals(deno.code, EXPORT_DENO_SMOKE_FAILED);
        assertEquals(deno.detail.includes("/five-hundred"), true);
      });
    });
  },
});

// --- Deno-smoke gate fixture-driven routes (Slice 4.3) ------------------------

// The app's only real surface is a mutating POST /orders and a parameterized GET
// /orders/:id — both skipped by the safe-subset default. Their productionTest
// fixtures (safe + a body example; a pathParams example) lift them into real
// probes: the gate issues POST /orders with a JSON body (→ 201) and GET
// /orders/123 (→ 200), both pass, and the coverage shows 2 probed / 0 skipped.
// Direct deno-gate call (fastest boot); the shared runRouteSmokeSubcheck wiring is
// identical across targets, so Node/binary aren't re-paid (see the note below).
Deno.test({
  name:
    "runDenoSmokeGate probes fixture-driven mutating + parameterized routes (Slice 4.3)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateFixtureRoutes(kernel);
      await withProjectDir(async (projectDir) => {
        const result = await runDenoSmokeGate(kernel, projectDir);

        assertEquals(result.ok, true, JSON.stringify(result).slice(0, 4000));
        if (result.ok) {
          assertEquals(result.data.healthStatus, 200);
          // openapi.json is emitted (schema-bearing routes), so it is checked.
          assertEquals(result.data.openApiChecked, true);
          // Both app routes were probed via their fixtures, and none skipped —
          // the skipped set shrank to empty precisely because the fixtures apply.
          assertEquals(result.data.routesProbed, 2);
          assertEquals(result.data.skipped.length, 0);
        }
      });
    });
  },
});

// A safe-marked mutating route whose handler 500s follows the same default
// advisory path: the target boot gate passes, and routeSmoke carries the warning.
Deno.test({
  name: "runDenoSmokeGate warns when a safe-marked mutating route returns 500",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateSafePost500(kernel);
      await withProjectDir(async (projectDir) => {
        let threw = false;
        let result;
        try {
          result = await runDenoSmokeGate(kernel, projectDir);
        } catch {
          threw = true;
        }
        assertEquals(threw, false);
        assertEquals(result?.ok, true);
        if (result?.ok) {
          assertEquals(result.data.routeSmoke.status, "warning");
          assertEquals(result.data.routeSmoke.routesFailed, 1);
          assertEquals(
            result.data.routeSmoke.failures[0]?.detail.includes("/orders"),
            true,
          );
        }
      });
    });
  },
});

// --- Node-smoke gate (real npm install + node main.js boot) -------------------

// These gates prove a frozen install (npm install --package-lock-only, then
// npm ci) and boot `node main.js`, so they hit the network and need node/npm on
// PATH — the same assumption core/build_test.ts's Node tests already make. The
// Node artifact is a different set of bytes than the Deno source export (esbuild
// transpile, rewriteMainForNode, deno.json → package.json, @hono/node-server
// bind), so this exercises a boot path the Deno gate cannot.

// The happy path is the end-to-end coverage of the frozen install: it generates
// an ephemeral package-lock.json (--package-lock-only), installs strictly from it
// with `npm ci`, then boots `node main.js`. A pass proves lock generation → npm ci
// → boot all succeed together.
Deno.test({
  name:
    "runNodeSmokeGate passes for a type-correct, schema-bearing kernel (real node boot)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      // A schema-bearing route → openapi.json is emitted, so the gate checks it.
      populateTypeCorrect(kernel);
      await withProjectDir(async (projectDir) => {
        const result = await runNodeSmokeGate(kernel, projectDir);

        assertEquals(result.ok, true, JSON.stringify(result).slice(0, 4000));
        if (result.ok) {
          assertEquals(result.data.healthStatus, 200);
          assertEquals(result.data.openApiChecked, true);
          assertEquals(result.data.versionChecked, true);
          // Slice 4.2: the shared route-smoke sub-check runs here too — the app's
          // single /alpha route is probed (framework pair excluded), none skipped.
          assertEquals(result.data.routesProbed, 1);
          assertEquals(result.data.skipped.length, 0);
          // And it answered. Probed is not passed: a route that 500s still counts
          // as probed, so without these two the gate would green-light an app
          // whose every handler throws.
          assertEquals(result.data.routeSmoke.status, "passed");
          assertEquals(result.data.routeSmoke.routesFailed, 0);
        }
      });
    });
  },
});

Deno.test({
  name:
    "runNodeSmokeGate waives the /openapi.json check when no openapi.json is emitted",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateNoOpenApi(kernel);
      await withProjectDir(async (projectDir) => {
        const result = await runNodeSmokeGate(kernel, projectDir);

        assertEquals(result.ok, true, JSON.stringify(result).slice(0, 4000));
        if (result.ok) {
          assertEquals(result.data.healthStatus, 200);
          // No openapi.json in the Node artifact → the OpenAPI check was waived.
          assertEquals(result.data.openApiChecked, false);
          assertEquals(result.data.versionChecked, true);
        }
      });
    });
  },
});

// The boom app throws at import time. `deno check` passes, the frozen install +
// `node main.js --version` still succeed (the version branch runs before
// createApp()), but `node main.js --random-port` crashes at createApp() before the
// ready line. The gate reaps the child and maps the early exit to
// EXPORT_NODE_SMOKE_FAILED without ever throwing.
//
// There is deliberately NO frozen-mismatch negative test here: the lock is
// generated in-gate to match package.json, so a lock/package.json disagreement
// can't be provoked without a committed lock — which this slice doesn't ship. The
// committed-lock-mismatch case lands with the deferred committed-lock slice.
Deno.test({
  name: "runNodeSmokeGate fails (never throws) when the app crashes on boot",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateAppBoom(kernel);
      await withProjectDir(async (projectDir) => {
        let threw = false;
        let result;
        try {
          result = await runNodeSmokeGate(kernel, projectDir);
        } catch {
          threw = true;
        }
        assertEquals(threw, false);
        assertEquals(result?.ok, false);
        if (result && !result.ok) {
          assertEquals(result.error.code, EXPORT_NODE_SMOKE_FAILED);
        }
      });
    });
  },
});

// --- Binary-smoke gate (real deno compile + native binary boot) ---------------

// These gates `deno compile` a standalone native binary and boot it as a child
// process, so they need --allow-run/--allow-write (granted by the test task) and
// are slow — a native compile snapshots the runtime. The compiled binary is a
// different artifact than both the Deno source export and the Node transpile: a
// self-contained bundle with an embedded runtime, no deno.json / npm: resolution /
// `deno task start`, invoked as `./app` with its isEntrypoint() predicate firing
// in the compiled context — a boot path neither the Deno nor Node gate exercises.

Deno.test({
  name:
    "runBinarySmokeGate passes for a type-correct, schema-bearing kernel (real binary boot)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      // A schema-bearing route → openapi.json is emitted, so the gate checks it.
      populateTypeCorrect(kernel);
      await withProjectDir(async (projectDir) => {
        const result = await runBinarySmokeGate(kernel, projectDir);

        assertEquals(result.ok, true, JSON.stringify(result).slice(0, 4000));
        if (result.ok) {
          assertEquals(result.data.healthStatus, 200);
          assertEquals(result.data.openApiChecked, true);
          assertEquals(result.data.versionChecked, true);
          // The compiled host triple is carried through so a report can show it.
          assertEquals(result.data.target, defaultBinaryCompileTarget());
          // Slice 4.2: the shared route-smoke sub-check runs here too — the app's
          // single /alpha route is probed (framework pair excluded), none skipped.
          assertEquals(result.data.routesProbed, 1);
          assertEquals(result.data.skipped.length, 0);
          // And it answered. Probed is not passed: a route that 500s still counts
          // as probed, so without these two the gate would green-light an app
          // whose every handler throws.
          assertEquals(result.data.routeSmoke.status, "passed");
          assertEquals(result.data.routeSmoke.routesFailed, 0);
        }
      });
    });
  },
});

Deno.test({
  name:
    "runBinarySmokeGate waives the /openapi.json check when no openapi.json is emitted",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateNoOpenApi(kernel);
      await withProjectDir(async (projectDir) => {
        const result = await runBinarySmokeGate(kernel, projectDir);

        assertEquals(result.ok, true, JSON.stringify(result).slice(0, 4000));
        if (result.ok) {
          assertEquals(result.data.healthStatus, 200);
          // No openapi.json in the export → the OpenAPI check was waived.
          assertEquals(result.data.openApiChecked, false);
          assertEquals(result.data.versionChecked, true);
        }
      });
    });
  },
});

// The boom app throws at import time. It compiles fine (a throwing const is valid
// TS) and `./app --version` still succeeds (the version branch runs before
// createApp()), but `./app --random-port` crashes at createApp() before the ready
// line. The gate reaps the child and maps the early exit to
// EXPORT_BINARY_SMOKE_FAILED without ever throwing.
Deno.test({
  name: "runBinarySmokeGate fails (never throws) when the app crashes on boot",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateAppBoom(kernel);
      await withProjectDir(async (projectDir) => {
        let threw = false;
        let result;
        try {
          result = await runBinarySmokeGate(kernel, projectDir);
        } catch {
          threw = true;
        }
        assertEquals(threw, false);
        assertEquals(result?.ok, false);
        if (result && !result.ok) {
          assertEquals(result.error.code, EXPORT_BINARY_SMOKE_FAILED);
        }
      });
    });
  },
});

// --- Stop-at-first-failure ordering -------------------------------------------

// When an earlier gate fails, the pipeline must not attempt the type-check gate
// (a broken export makes it meaningless), and that gate must be absent from the
// report. Asserted against the real sequencer with synthetic steps so the
// earlier-gate failure is deterministic.
Deno.test("sequenceGates stops at the first failed gate and omits later gates", async () => {
  let typeCheckRan = false;

  const gates = await sequenceGates([
    {
      gate: GATE_MANIFEST,
      run: () =>
        Promise.resolve({
          gate: GATE_MANIFEST,
          status: "failed",
          code: "MANIFEST_HASH_MISMATCH",
          detail: "tampered",
        }),
    },
    {
      gate: GATE_TYPE_CHECK,
      run: () => {
        typeCheckRan = true;
        return Promise.resolve({
          gate: GATE_TYPE_CHECK,
          status: "passed",
          detail: "unreached",
        });
      },
    },
  ]);

  assertEquals(gateNames(gates), [GATE_MANIFEST]);
  assertEquals(gates.some((g) => g.gate === GATE_TYPE_CHECK), false);
  assertEquals(typeCheckRan, false);
});

// --- Skip passes through the sequencer (Slice 3.5.1) ---------------------------

// A "skipped" outcome must NOT stop the pipeline — later gates still run — while a
// "failed" outcome still does. No real gate skips yet, so this is proven with
// synthetic steps: a [passed, skipped, passed] list runs to completion (all three
// present, order preserved); the contrasting [passed, failed, passed] list stops
// after the failure (only two present).
Deno.test("sequenceGates passes skips through but still stops on failure", async () => {
  const skipped = await sequenceGates([
    {
      gate: "a",
      run: () => Promise.resolve({ gate: "a", status: "passed", detail: "ok" }),
    },
    {
      gate: "b",
      run: () => Promise.resolve(skippedOutcome("b", "not selected")),
    },
    {
      gate: "c",
      run: () => Promise.resolve({ gate: "c", status: "passed", detail: "ok" }),
    },
  ]);
  assertEquals(gateNames(skipped), ["a", "b", "c"]);
  assertEquals(skipped.map((g) => g.status), ["passed", "skipped", "passed"]);

  const failed = await sequenceGates([
    {
      gate: "a",
      run: () => Promise.resolve({ gate: "a", status: "passed", detail: "ok" }),
    },
    {
      gate: "b",
      run: () =>
        Promise.resolve({
          gate: "b",
          status: "failed",
          code: "X",
          detail: "boom",
        }),
    },
    {
      gate: "c",
      run: () => Promise.resolve({ gate: "c", status: "passed", detail: "ok" }),
    },
  ]);
  assertEquals(gateNames(failed), ["a", "b"]);
  assertEquals(failed.some((g) => g.gate === "c"), false);
});

// --- reportOk pass/fail semantics (Slice 3.5.1) --------------------------------

// reportOk is true iff the pipeline ran to completion (length === stepCount) and no
// gate failed; skipped gates are acceptable, a short list (early stop) is not.
Deno.test("reportOk treats skips as acceptable and failures/short-runs as not-ok", () => {
  const passed = (gate: string): GateOutcome => ({
    gate,
    status: "passed",
    detail: "ok",
  });
  const failed = (gate: string): GateOutcome => ({
    gate,
    status: "failed",
    code: "X",
    detail: "boom",
  });

  // All passed, full length → true.
  assertEquals(reportOk([passed("a"), passed("b"), passed("c")], 3), true);
  // A skip mixed with passes, full length → true.
  assertEquals(
    reportOk(
      [passed("a"), skippedOutcome("b", "not selected"), passed("c")],
      3,
    ),
    true,
  );
  // Any failed → false (even at full length).
  assertEquals(reportOk([passed("a"), failed("b"), passed("c")], 3), false);
  // A short list (early stop, length < stepCount) → false.
  assertEquals(reportOk([passed("a"), failed("b")], 3), false);
});

// --- skippedOutcome shape (Slice 3.5.1) ----------------------------------------

Deno.test("skippedOutcome carries the reason and sets no code", () => {
  const outcome = skippedOutcome(GATE_MANIFEST, "target not selected");
  assertEquals(outcome.status, "skipped");
  assertEquals(outcome.detail, "target not selected");
  assertEquals(outcome.code, undefined);
  assertEquals(outcome.gate, GATE_MANIFEST);
});

// --- Never throws -------------------------------------------------------------

// The orchestrator represents a failing gate as ok: false rather than throwing —
// the type-error kernel exercises the real subprocess negative path (a spawn/
// permission failure would map to the same EXPORT_TYPE_CHECK_FAILED code).
Deno.test("runProductionBuild does not throw on a gate failure", async () => {
  await withKernel(async (kernel) => {
    populateTypeError(kernel);
    await withProjectDir(async (projectDir) => {
      let threw = false;
      let ok = true;
      try {
        const report = await runProductionBuild(kernel, projectDir);
        ok = report.ok;
      } catch {
        threw = true;
      }
      assertEquals(threw, false);
      assertEquals(ok, false);
    });
  });
});

// --- In-process createApp() harness (Phase 6 refactor) ------------------------

// The Phase 6 refactor makes the wired app importable without booting a server,
// which is what unblocks the app-start + /_health smoke gate (the next slice).
// This drives the app in-process via app.fetch(): importing main.ts must start
// no server and must not exit, createApp() must serve /_health, and the
// /openapi.json route must be wired when a schema-bearing route exists.
Deno.test({
  name:
    "generated main.ts exposes an importable createApp() that serves /_health + /openapi.json without booting a server",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      // A schema-bearing route so openapi.json is emitted and its route wired.
      populateTypeCorrect(kernel);
      await withProjectDir(async (dir) => {
        const { files } = await exportProject(kernel);
        writeExportFiles(dir, files);

        // createApp reads schema.sql / openapi.json relative to the cwd, and
        // deps.ts opens its PGlite data dir there too, so drive the imported
        // module from inside the exported tree.
        const prevCwd = Deno.cwd();
        Deno.chdir(dir);
        try {
          const mod = await import(
            pathToFileURL(join(dir, "main.ts")).href
          ) as {
            createApp?: () => Promise<
              { fetch: (req: Request) => Response | Promise<Response> }
            >;
            app?: unknown;
          };

          // (a) Importing the module started no server and did not exit the
          // process (we are still running), and exposes no top-level `app`.
          assertEquals(typeof mod.createApp, "function");
          assertEquals(mod.app, undefined);

          const app = await mod.createApp!();

          // (b) /_health answers 200 with the { ok, name, version } contract.
          const health = await app.fetch(new Request("http://local/_health"));
          assertEquals(health.status, 200);
          assertEquals(await health.json(), {
            ok: true,
            name: "Genie App",
            version: "unversioned",
          });

          // (c) /openapi.json is wired because a schema-bearing route exists.
          const openapi = await app.fetch(
            new Request("http://local/openapi.json"),
          );
          assertEquals(openapi.status, 200);
          assertEquals(
            openapi.headers.get("content-type"),
            "application/json; charset=utf-8",
          );
        } finally {
          Deno.chdir(prevCwd);
        }
      });
    });
  },
});

// Stage 7 (docs/framework-free-handler-abi-plan.md): a fetch-ABI handler has to
// survive the export end to end — type check, then a real boot with a real HTTP
// probe. The Deno gate is the cheap one of the three (no npm ci, no deno compile),
// and the ABI is target-independent, so it carries this on its own.
Deno.test({
  name: "runDenoSmokeGate passes for a fetch-ABI handler (real boot)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateFetchAbi(kernel);
      await withProjectDir(async (projectDir) => {
        const typeCheck = await runTypeCheckGate(kernel, projectDir);
        assertEquals(typeCheck.ok, true);

        const result = await runDenoSmokeGate(kernel, projectDir);
        assertEquals(result.ok, true, JSON.stringify(result).slice(0, 4000));
        if (result.ok) {
          assertEquals(result.data.healthStatus, 200);
          assertEquals(result.data.routeSmoke.status, "passed");
          assertEquals(result.data.routeSmoke.routesProbed, 1);
          assertEquals(result.data.routeSmoke.routesFailed, 0);
        }
      });
    });
  },
});

// Stage 8 (docs/framework-free-handler-abi-plan.md): the Node target needs no code
// change for the fetch ABI, but "the ABI is target-independent" was an assumption,
// not a measurement. It isn't obviously true: under Node the Request the adapter
// closure passes to the handler is built by @hono/node-server from an
// IncomingMessage, not by Deno, and `populateFetchAbi`'s handler parses `req.url`
// with `new URL(...)` — which needs an absolute URL. So boot it for real on the
// Node artifact too.
//
// This also re-proves both of rewriteMainForNode's anchors after stage 7 touched
// the emitted main.ts: the `import { ... } from "hono"` line that carries the
// @hono/node-server injection, and the verbatim `Deno.serve` line in `listenOn`
// that gets swapped for `serve(...)`. Miss either and the app never binds a port,
// so this test fails by timing out rather than by a diagnostic.
//
// The route-smoke sub-check probes GETs only (mutating methods are skipped), so a
// body-reading handler can't ride this gate — core/export_test.ts's POST-through-
// app.fetch test covers that, on Deno.
Deno.test({
  name: "runNodeSmokeGate passes for a fetch-ABI handler (real node boot)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateFetchAbi(kernel);
      await withProjectDir(async (projectDir) => {
        const result = await runNodeSmokeGate(kernel, projectDir);

        assertEquals(result.ok, true, JSON.stringify(result).slice(0, 4000));
        if (result.ok) {
          assertEquals(result.data.healthStatus, 200);
          assertEquals(result.data.versionChecked, true);
          assertEquals(result.data.skipped.length, 0);
          // routesProbed alone is not a gate: a route that 500s is still a route
          // that was probed. The status and failure count are what catch a handler
          // invoked with the wrong argument.
          assertEquals(result.data.routeSmoke.status, "passed");
          assertEquals(result.data.routeSmoke.routesProbed, 1);
          assertEquals(result.data.routeSmoke.routesFailed, 0);
        }
      });
    });
  },
});

// --- A user package colliding with one of the shell's own dependencies -------------

// Installing a framework is the endorsed carve-out, not a mistake: the agent is told
// to `install_package` one and mount it from a catch-all route with
// `return app.fetch(req)`. When the framework the user picks is the SAME NAME the
// generated shell bundles, the export emits the user's copy under an alias and keeps
// the canonical key for its own pin (core/runtime-dependencies.ts
// planAppPackageEmission). core/runtime-dependency-collision_test.ts proves the
// manifests; these two prove the artifact actually BOOTS with both copies present and
// serves a route through the user's version.
//
// Confirmed by backing the alias out: the Node case then fails with npm ERESOLVE
// (`peer hono@"^4" from @hono/node-server@1.19.17`) while the DENO CASE STILL PASSES
// GREEN on the user's Hono 3. So the Deno test below is not a regression gate for the
// displacement — nothing at boot can be, on a runtime with no peer-dependency concept.
// It proves the aliased artifact still runs; the manifest assertions in
// core/runtime-dependency-collision_test.ts and the emission-time invariant in
// assertRuntimeDependencyPins are what actually catch the bug.
function populateMountedUserFramework(kernel: Kernel): void {
  kernel.handlers.register(
    "mounted",
    `async function mounted(req: Request, ctx: HandlerContext): Promise<Response> {
  const { Hono } = packages.hono as {
    Hono: new () => {
      get(path: string, handler: () => Response): void;
      fetch(req: Request): Promise<Response>;
    };
  };
  const app = new Hono();
  app.get("/mounted", () => Response.json({ mounted: true }));
  return await app.fetch(req);
}`,
    () => new Response(),
  );
  kernel.routes.register("GET", "/mounted", "mounted", { summary: "mounted" });
}

// `kernel.runtime` is a shared module-level singleton, so the override must be
// restored or every later test in this file resolves a fake specifier off npm.
async function withUserHono3(
  kernel: Kernel,
  fn: () => Promise<void>,
): Promise<void> {
  const runtime = kernel.runtime as unknown as {
    listPackages: (k: Kernel) => Array<
      { name: string; specifier: string; installedAt: string }
    >;
  };
  const original = runtime.listPackages;
  runtime.listPackages = () => [{
    name: "hono",
    specifier: "npm:hono@3",
    installedAt: "2026-01-01T00:00:00.000Z",
  }];
  try {
    await fn();
  } finally {
    runtime.listPackages = original;
  }
}

Deno.test({
  name:
    "runDenoSmokeGate boots with a user hono@3 alongside the shell's hono@4 (real deno boot)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateMountedUserFramework(kernel);
      await withUserHono3(kernel, async () => {
        await withProjectDir(async (projectDir) => {
          const result = await runDenoSmokeGate(kernel, projectDir);
          assertEquals(result.ok, true, JSON.stringify(result).slice(0, 4000));
          if (result.ok) {
            assertEquals(result.data.healthStatus, 200);
            assertEquals(result.data.routeSmoke.status, "passed");
            assertEquals(result.data.routeSmoke.routesFailed, 0);
          }
        });
      });
    });
  },
});

Deno.test({
  name:
    "runNodeSmokeGate boots with a user hono@3 alongside the shell's hono@4 (real node boot)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateMountedUserFramework(kernel);
      await withUserHono3(kernel, async () => {
        await withProjectDir(async (projectDir) => {
          const result = await runNodeSmokeGate(kernel, projectDir);
          assertEquals(result.ok, true, JSON.stringify(result).slice(0, 4000));
          if (result.ok) {
            assertEquals(result.data.healthStatus, 200);
            assertEquals(result.data.routeSmoke.status, "passed");
            assertEquals(result.data.routeSmoke.routesFailed, 0);
          }
        });
      });
    });
  },
});

Deno.test({
  name:
    "runNodeSmokeGate: a schema-violating body is rejected by the real node artifact",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateRejectsBadBody(kernel);
      await withProjectDir(async (projectDir) => {
        const result = await runNodeSmokeGate(kernel, projectDir);
        assertEquals(result.ok, true, JSON.stringify(result).slice(0, 4000));
        if (result.ok) {
          assertEquals(result.data.routesProbed, 1);
          assertEquals(result.data.skipped.length, 0);
          // The probe expected 400 and got it. If the transpiled validators were not
          // wired, the handler would run and 500, and routesFailed would be 1.
          assertEquals(result.data.routeSmoke.status, "passed");
          assertEquals(result.data.routeSmoke.routesFailed, 0);
        }
      });
    });
  },
});

Deno.test({
  name:
    "runBinarySmokeGate: a schema-violating body is rejected by the compiled binary",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    await withKernel(async (kernel) => {
      populateRejectsBadBody(kernel);
      await withProjectDir(async (projectDir) => {
        const result = await runBinarySmokeGate(kernel, projectDir);
        assertEquals(result.ok, true, JSON.stringify(result).slice(0, 4000));
        if (result.ok) {
          assertEquals(result.data.routesProbed, 1);
          assertEquals(result.data.skipped.length, 0);
          assertEquals(result.data.routeSmoke.status, "passed");
          assertEquals(result.data.routeSmoke.routesFailed, 0);
        }
      });
    });
  },
});
