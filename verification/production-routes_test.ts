// @layer verification — Slice 5.2 endpoint tests. They mount mountProductionRoutes
// on a bare Hono app with an INJECTED fake runner, so the whole POST → poll →
// download job lifecycle is exercised deterministically without a real subprocess
// build (the real runProductionBuild path stays covered by production-build_test.ts).
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import {
  lockRefreshAttestationInputs,
  type LockRefreshRunner,
  mountProductionRoutes,
  productionAttestationInputs,
  type ProductionBuildRunner,
} from "./production-routes.ts";
import {
  type LockRefreshReport,
  type RefreshTarget,
} from "./production-lock-refresh.ts";
import type { LockRefreshJob } from "../shared/lock-refresh.ts";
import {
  type BuildTarget,
  GATE_APP_SMOKE,
  GATE_BINARY_SMOKE,
  GATE_DENO_SMOKE,
  GATE_DETERMINISM,
  GATE_MANIFEST,
  GATE_NODE_SMOKE,
  GATE_ROUTE_PARITY,
  GATE_TYPE_CHECK,
  type GateOutcome,
  type ProductionBuildReport,
  TARGET_DENO_SOURCE,
  TARGET_NODE,
} from "./production-build.ts";
import { MANIFEST_PATH, sha256Hex } from "../core/export.ts";
import {
  PRODUCTION_CHANGESET_ID,
  PRODUCTION_CHANGESET_TITLE,
  PRODUCTION_SCOPE,
} from "../core/fingerprint.ts";
import type { CoreRouteContext } from "../core/route-mount.ts";
import type { Kernel } from "../core/registries.ts";
import type {
  AttestationInput,
  Changeset,
  LedgerEntry,
} from "../core/types.ts";
import type {
  ProductionBuildJob,
  ProductionBuildResult,
  ProductionGateResult,
  ProductionGateStatus,
} from "../shared/production-build.ts";

// A projectDir with no version.json → getVersion degrades to its default, so the
// download filename is deterministic while the base comes from the registry name.
const PROJECT_DIR = "/tmp/genie-production-routes-test-nonexistent";
const PROJECT_NAME = "My Cool App";
const EXPECTED_VERSION = "0.1.0";
const EXPECTED_TARBALL_FILENAME = "my-cool-app-v0.1.0.tar";
const TARBALL_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

// An in-memory sink capturing the ledger writes the recording path makes, so a
// test can assert what a passing build attested (Slice 5.4).
interface LedgerSink {
  ledger: LedgerEntry[];
  attestations: { changesetId: string; att: AttestationInput }[];
}

function newSink(): LedgerSink {
  return { ledger: [], attestations: [] };
}

// A fake Kernel exposing the projectDir the mounter reads plus the changeset seam
// the Slice 5.4 recording path drives (getActive + recordAttestation /
// recordLedgerEntry) and a no-op logger. `active` selects the association path
// (an in_progress changeset → recordAttestation; else the synthetic ledger row);
// `throwOnRecord` models a ledger-write failure to prove recording is best-effort.
function fakeKernel(opts?: {
  sink?: LedgerSink;
  active?: Changeset | null;
  throwOnRecord?: boolean;
}): Kernel {
  return {
    projectDir: PROJECT_DIR,
    log: { log: () => {} },
    changesets: {
      getActive: () => Promise.resolve(opts?.active ?? null),
      recordAttestation: (changesetId: string, att: AttestationInput) => {
        if (opts?.throwOnRecord) {
          return Promise.reject(new Error("record boom"));
        }
        opts?.sink?.attestations.push({ changesetId, att });
        return Promise.resolve({} as Changeset);
      },
      recordLedgerEntry: (entry: LedgerEntry) => {
        if (opts?.throwOnRecord) {
          return Promise.reject(new Error("ledger boom"));
        }
        opts?.sink?.ledger.push(entry);
        return Promise.resolve();
      },
    },
  } as unknown as Kernel;
}

// A CoreRouteContext with a project always "open" (requireKernel → null). The
// injected fake runner ignores the kernel for the build itself; the kernel's
// changeset seam is what the Slice 5.4 recording path uses.
function fakeCore(kernel: Kernel = fakeKernel()): CoreRouteContext {
  return {
    requireKernel: () => null,
    project: () => ({ path: PROJECT_DIR, name: PROJECT_NAME }),
    kernel: () => kernel,
    rebuild: () => {},
    serverToken: () => null,
    onProjectClose: () => {},
    track: () => {},
  };
}

// A well-formed manifest.json so the projection's artifact summary parses (the DTO
// artifact + the download digest both populate on a passing build).
function manifestFile() {
  const manifest = {
    sourceFingerprint: "fp-test",
    files: [{ path: "main.ts", sha256: "abc123", bytes: 42 }],
  };
  return { path: MANIFEST_PATH, content: JSON.stringify(manifest) };
}

function successReport(): ProductionBuildReport {
  return {
    ok: true,
    sourceFingerprint: "fp-test",
    gates: [{ gate: GATE_MANIFEST, status: "passed", detail: "ok" }],
    artifact: { files: [manifestFile()], tarball: TARBALL_BYTES },
  };
}

// A gate failure is a RESULT (ok: false), not an error — and it carries no
// artifact (the orchestrator only retains one on a full pass).
function gateFailureReport(): ProductionBuildReport {
  return {
    ok: false,
    sourceFingerprint: "fp-test",
    gates: [
      { gate: GATE_MANIFEST, status: "passed", detail: "ok" },
      {
        gate: GATE_TYPE_CHECK,
        status: "failed",
        code: "EXPORT_TYPE_CHECK_FAILED",
        detail: "boom",
      },
    ],
  };
}

// A runner that records the (targets, opts) it was called with and returns a
// canned report.
function captureRunner(report: ProductionBuildReport) {
  const calls: {
    targets: ReadonlySet<BuildTarget>;
    name: string | undefined;
    version: string | undefined;
    includeEnvFile: boolean | undefined;
    strictRouteSmoke: boolean | undefined;
  }[] = [];
  const run: ProductionBuildRunner = (_kernel, _projectDir, opts, targets) => {
    calls.push({
      targets: targets ?? new Set<BuildTarget>(),
      name: opts?.projectName,
      version: opts?.projectVersion,
      includeEnvFile: opts?.includeEnvFile,
      strictRouteSmoke: opts?.strictRouteSmoke,
    });
    return Promise.resolve(report);
  };
  return { run, calls };
}

function app(runBuild: ProductionBuildRunner, kernel?: Kernel): Hono {
  const a = new Hono();
  mountProductionRoutes(a, fakeCore(kernel), runBuild);
  return a;
}

async function postBuild(a: Hono, body?: unknown): Promise<Response> {
  return await a.request("/api/production/build", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

// Poll the status endpoint until the job leaves "running" (the realistic client
// pattern; also lets the detached build's async digest settle).
async function pollJob(a: Hono, id: string): Promise<ProductionBuildJob> {
  for (let i = 0; i < 50; i++) {
    const res = await a.request(`/api/production/build/${id}`);
    const job = await res.json() as ProductionBuildJob;
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not settle");
}

Deno.test("POST mints a running job; poll yields the projected DTO + tarball digest", async () => {
  const a = app(captureRunner(successReport()).run);

  const postRes = await postBuild(a);
  assertEquals(postRes.status, 202);
  const posted = await postRes.json() as ProductionBuildJob;
  assertEquals(posted.status, "running");
  assert(posted.id.startsWith("prod_"), "id has the prod_ prefix");
  assertEquals(posted.targets, ["deno-source"]);
  assert(typeof posted.startedAt === "string" && posted.startedAt.length > 0);

  const job = await pollJob(a, posted.id);
  assertEquals(job.status, "done");
  assert(typeof job.completedAt === "string");

  const result = job.result as ProductionBuildResult;
  assertEquals(result.ok, true);
  assertEquals(result.status, "passed");
  assert(result.artifact !== null, "DTO artifact parsed from the manifest");
  assertEquals(result.artifact?.sourceFingerprint, "fp-test");

  // The digest the projection deferred, computed at the endpoint.
  const expectedDigest = await sha256Hex(TARBALL_BYTES);
  assert(job.download, "download affordance present on an artifact build");
  assertEquals(job.download?.tarballSha256, expectedDigest);
  assertEquals(job.download?.bytes, TARBALL_BYTES.length);
  assertEquals(job.download?.filename, EXPECTED_TARBALL_FILENAME);
});

Deno.test("download streams the retained tarball as a tar attachment", async () => {
  const a = app(captureRunner(successReport()).run);
  const posted = await (await postBuild(a)).json() as ProductionBuildJob;
  const job = await pollJob(a, posted.id);

  const res = await a.request(`/api/production/build/${job.id}/download`);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "application/x-tar");
  assertEquals(
    res.headers.get("content-disposition"),
    `attachment; filename=${EXPECTED_TARBALL_FILENAME}`,
  );
  const bytes = new Uint8Array(await res.arrayBuffer());
  assertEquals(bytes, TARBALL_BYTES);
});

Deno.test("a gate failure is a done result with no artifact; download is 409", async () => {
  const a = app(captureRunner(gateFailureReport()).run);
  const posted = await (await postBuild(a)).json() as ProductionBuildJob;
  const job = await pollJob(a, posted.id);

  assertEquals(job.status, "done");
  const result = job.result as ProductionBuildResult;
  assertEquals(result.ok, false);
  assertEquals(result.status, "failed");
  assertEquals(job.download, null);

  const res = await a.request(`/api/production/build/${job.id}/download`);
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "build produced no artifact");
});

Deno.test("single-flight: a second POST while running returns 409 naming the running id", async () => {
  // A gated runner that stays "running" until released, so the first job is still
  // in flight when the second POST arrives.
  let release!: (report: ProductionBuildReport) => void;
  const gate = new Promise<ProductionBuildReport>((r) => {
    release = r;
  });
  const run: ProductionBuildRunner = () => gate;
  const a = app(run);

  const first = await (await postBuild(a)).json() as ProductionBuildJob;
  assertEquals(first.status, "running");

  const secondRes = await postBuild(a);
  assertEquals(secondRes.status, 409);
  const second = await secondRes.json();
  assertEquals(second.error, "a production build is already running");
  assertEquals(second.id, first.id);

  // Release + drain so nothing dangles past the test.
  release(successReport());
  const done = await pollJob(a, first.id);
  assertEquals(done.status, "done");
});

Deno.test("unknown job id is 404 on both status and download", async () => {
  const a = app(captureRunner(successReport()).run);
  const statusRes = await a.request("/api/production/build/prod_nope");
  assertEquals(statusRes.status, 404);
  assertEquals((await statusRes.json()).error, "build job not found");

  const downloadRes = await a.request(
    "/api/production/build/prod_nope/download",
  );
  assertEquals(downloadRes.status, 404);
});

Deno.test("an unexpected throw around the build leaves the job in error, not running", async () => {
  const run: ProductionBuildRunner = () =>
    Promise.reject(new Error("export exploded"));
  const a = app(run);
  const posted = await (await postBuild(a)).json() as ProductionBuildJob;

  const job = await pollJob(a, posted.id);
  assertEquals(job.status, "error");
  assertEquals(job.error, "export exploded");
  assertEquals(job.result, undefined);

  // No artifact to download from an errored build.
  const res = await a.request(`/api/production/build/${job.id}/download`);
  assertEquals(res.status, 409);
  assertEquals((await res.json()).error, "build is not complete");
});

Deno.test("targets: an unknown target is rejected 400 before any build starts", async () => {
  const captured = captureRunner(successReport());
  const a = app(captured.run);
  const res = await postBuild(a, { targets: ["frobnicate"] });
  assertEquals(res.status, 400);
  assert((await res.json()).error.includes("frobnicate"));
  assertEquals(captured.calls.length, 0);
});

Deno.test("targets: node/binary selection reaches the runner and the envelope in canonical order", async () => {
  const captured = captureRunner(successReport());
  const a = app(captured.run);
  const posted = await (await postBuild(a, {
    targets: ["binary", "node"],
    includeEnvFile: true,
    strictRouteSmoke: true,
  })).json() as ProductionBuildJob;

  // Envelope reports the full built set (deno-source always) in canonical order.
  assertEquals(posted.targets, ["deno-source", "node", "binary"]);

  const job = await pollJob(a, posted.id);
  assertEquals(job.status, "done");

  assertEquals(captured.calls.length, 1);
  const call = captured.calls[0]!;
  assertEquals([...call.targets].sort(), ["binary", "deno-source", "node"]);
  assertEquals(call.name, PROJECT_NAME);
  assertEquals(call.version, EXPECTED_VERSION);
  assertEquals(call.includeEnvFile, true);
  assertEquals(call.strictRouteSmoke, true);
});

// --- Slice 5.4: ledger attestations -------------------------------------------

// A DTO gate result (the flat checklist the helper reads).
function dtoGate(
  gate: string,
  status: ProductionGateStatus = "passed",
): ProductionGateResult {
  return { gate, status, detail: status };
}

// A passing DTO. `node`/`binary` control whether those target smoke gates ran
// (passed) or were skipped (not selected). deno-source's five core gates and
// route_parity always pass here; an artifact is present.
function passingDto(
  opts: { node?: boolean; binary?: boolean } = {},
): ProductionBuildResult {
  return {
    ok: true,
    status: "passed",
    sourceFingerprint: "fp-test",
    gates: [
      dtoGate(GATE_MANIFEST),
      dtoGate(GATE_DETERMINISM),
      dtoGate(GATE_TYPE_CHECK),
      dtoGate(GATE_APP_SMOKE),
      dtoGate(GATE_DENO_SMOKE),
      dtoGate(GATE_NODE_SMOKE, opts.node ? "passed" : "skipped"),
      dtoGate(GATE_BINARY_SMOKE, opts.binary ? "passed" : "skipped"),
      dtoGate(GATE_ROUTE_PARITY),
    ],
    targets: [{ target: "deno-source", status: "passed", gates: [] }],
    parity: dtoGate(GATE_ROUTE_PARITY),
    artifact: {
      sourceFingerprint: "fp-test",
      files: [{ path: "main.ts", sha256: "abc123", bytes: 42 }],
    },
  };
}

function kindsOf(inputs: AttestationInput[]): string[] {
  return inputs.map((i) => i.kind).sort();
}

Deno.test("productionAttestationInputs: a deno-only pass earns four kinds, not binary_smoke", () => {
  const inputs = productionAttestationInputs(passingDto(), "sha-abc");
  assertEquals(kindsOf(inputs), [
    "artifact_hash",
    "production_export",
    "route_smoke",
    "target_parity",
  ]);
  // Every attestation is production-scoped, passed, and fingerprinted to the build.
  for (const att of inputs) {
    assertEquals(att.scope, PRODUCTION_SCOPE);
    assertEquals(att.status, "passed");
    assertEquals(att.fingerprint, "fp-test");
  }
  // The endpoint-computed tarball digest + file count land in the artifact summary.
  const artifact = inputs.find((i) => i.kind === "artifact_hash")!;
  assert(
    artifact.summary.includes("sha-abc"),
    "summary carries the tarball digest",
  );
  assert(artifact.summary.includes("1 file"), "summary carries the file count");
});

Deno.test("productionAttestationInputs: a node+binary pass adds binary_smoke", () => {
  const inputs = productionAttestationInputs(
    passingDto({ node: true, binary: true }),
    "sha-abc",
  );
  assertEquals(kindsOf(inputs), [
    "artifact_hash",
    "binary_smoke",
    "production_export",
    "route_smoke",
    "target_parity",
  ]);
});

Deno.test("productionAttestationInputs: a failed build attests nothing", () => {
  const failed: ProductionBuildResult = {
    ...passingDto(),
    ok: false,
    status: "failed",
    artifact: null,
  };
  assertEquals(productionAttestationInputs(failed, null), []);
});

Deno.test("productionAttestationInputs: a null source fingerprint attests nothing", () => {
  const noFp: ProductionBuildResult = {
    ...passingDto(),
    sourceFingerprint: null,
  };
  assertEquals(productionAttestationInputs(noFp, null), []);
});

// A passing ProductionBuildReport the projection turns into a passing DTO. `node`/
// `binary` toggle those target smoke gates between passed and skipped.
function passingReport(
  opts: { node?: boolean; binary?: boolean } = {},
): ProductionBuildReport {
  const gates: GateOutcome[] = [
    { gate: GATE_MANIFEST, status: "passed", detail: "ok" },
    { gate: GATE_DETERMINISM, status: "passed", detail: "ok" },
    { gate: GATE_TYPE_CHECK, status: "passed", detail: "ok" },
    { gate: GATE_APP_SMOKE, status: "passed", detail: "ok" },
    { gate: GATE_DENO_SMOKE, status: "passed", detail: "ok" },
    {
      gate: GATE_NODE_SMOKE,
      status: opts.node ? "passed" : "skipped",
      detail: "ok",
    },
    {
      gate: GATE_BINARY_SMOKE,
      status: opts.binary ? "passed" : "skipped",
      detail: "ok",
    },
    { gate: GATE_ROUTE_PARITY, status: "passed", detail: "ok" },
  ];
  return {
    ok: true,
    sourceFingerprint: "fp-test",
    gates,
    artifact: { files: [manifestFile()], tarball: TARBALL_BYTES },
  };
}

Deno.test("recording: a deno-only ok build writes four production-scoped ledger rows (synthetic changeset)", async () => {
  const sink = newSink();
  const a = app(captureRunner(passingReport()).run, fakeKernel({ sink }));
  const posted = await (await postBuild(a)).json() as ProductionBuildJob;
  const job = await pollJob(a, posted.id);
  assertEquals(job.status, "done");

  assertEquals(
    sink.ledger.map((e) => e.kind).sort(),
    ["artifact_hash", "production_export", "route_smoke", "target_parity"],
  );
  const digest = await sha256Hex(TARBALL_BYTES);
  for (const entry of sink.ledger) {
    assertEquals(entry.scope, PRODUCTION_SCOPE);
    assertEquals(entry.changesetId, PRODUCTION_CHANGESET_ID);
    assertEquals(entry.changesetTitle, PRODUCTION_CHANGESET_TITLE);
    assert(entry.id.length > 0 && typeof entry.createdAt === "string");
  }
  const artifact = sink.ledger.find((e) => e.kind === "artifact_hash")!;
  assert(
    artifact.summary.includes(digest),
    "artifact_hash carries the tarball digest",
  );
  // No changeset-scoped path was taken.
  assertEquals(sink.attestations.length, 0);
});

Deno.test("recording: a node+binary ok build adds a binary_smoke ledger row", async () => {
  const sink = newSink();
  const a = app(
    captureRunner(passingReport({ node: true, binary: true })).run,
    fakeKernel({ sink }),
  );
  const posted = await (await postBuild(a, { targets: ["node", "binary"] }))
    .json() as ProductionBuildJob;
  await pollJob(a, posted.id);

  assertEquals(
    sink.ledger.map((e) => e.kind).sort(),
    [
      "artifact_hash",
      "binary_smoke",
      "production_export",
      "route_smoke",
      "target_parity",
    ],
  );
});

Deno.test("recording: an active in_progress changeset takes the changeset-scoped path", async () => {
  const sink = newSink();
  const active = { id: "cs-active", status: "in_progress" } as Changeset;
  const a = app(
    captureRunner(passingReport()).run,
    fakeKernel({ sink, active }),
  );
  const posted = await (await postBuild(a)).json() as ProductionBuildJob;
  await pollJob(a, posted.id);

  // Recorded via recordAttestation on the active changeset, not the synthetic row.
  assertEquals(sink.ledger.length, 0);
  assertEquals(sink.attestations.length, 4);
  for (const { changesetId, att } of sink.attestations) {
    assertEquals(changesetId, "cs-active");
    assertEquals(att.scope, PRODUCTION_SCOPE);
  }
});

Deno.test("recording: a failed build records nothing", async () => {
  const sink = newSink();
  const a = app(captureRunner(gateFailureReport()).run, fakeKernel({ sink }));
  const posted = await (await postBuild(a)).json() as ProductionBuildJob;
  const job = await pollJob(a, posted.id);

  assertEquals(job.status, "done");
  assertEquals(job.result?.ok, false);
  assertEquals(sink.ledger.length, 0);
  assertEquals(sink.attestations.length, 0);
});

Deno.test("recording is best-effort: a throwing ledger writer leaves the job done, not error", async () => {
  const a = app(
    captureRunner(passingReport()).run,
    fakeKernel({ throwOnRecord: true }),
  );
  const posted = await (await postBuild(a)).json() as ProductionBuildJob;
  const job = await pollJob(a, posted.id);

  // The build result stays authoritative; a ledger-write failure never flips it.
  assertEquals(job.status, "done");
  assertEquals(job.result?.ok, true);
  assertEquals(job.error, undefined);
});

// --- Slice 7.2: lock-refresh endpoints ----------------------------------------
// Same discipline as the build tests: an INJECTED fake refresh runner drives the
// POST → poll job lifecycle deterministically without a real network install (the
// real producer↔gate path stays covered by production-lock-refresh_test.ts). The
// build and refresh share ONE single-flight guard (they must never overlap).

// A refresh report with both targets refreshed. `nodeStatus` lets a test model a
// node failure/skip without touching deno-source.
function refreshReport(
  nodeStatus: LockRefreshReport["targets"][number]["status"] = "refreshed",
): LockRefreshReport {
  const node: LockRefreshReport["targets"][number] = nodeStatus === "failed"
    ? {
      target: TARGET_NODE,
      status: "failed",
      code: "NODE_LOCK_REFRESH_FAILED",
      detail: "boom",
    }
    : nodeStatus === "refreshed"
    ? {
      target: TARGET_NODE,
      status: "refreshed",
      detail: "refreshed",
      // Slice 7.4: a refreshed target carries the produced-lock provenance the
      // endpoint mints its lock_refresh attestation from.
      lock: {
        lockfile: "package-lock.json",
        packageCount: 3,
        sha256: "node-sha",
      },
    }
    : { target: TARGET_NODE, status: nodeStatus, detail: nodeStatus };
  return {
    ok: nodeStatus !== "failed",
    targets: [
      {
        target: TARGET_DENO_SOURCE,
        status: "refreshed",
        detail: "ok",
        lock: { lockfile: "deno.lock", packageCount: 5, sha256: "deno-sha" },
      },
      node,
    ],
  };
}

// A refresh runner that records the target set it was called with and returns a
// canned report.
function captureRefreshRunner(report: LockRefreshReport) {
  const calls: { targets: ReadonlySet<RefreshTarget> }[] = [];
  const run: LockRefreshRunner = (_kernel, _projectDir, _opts, targets) => {
    calls.push({ targets: targets ?? new Set<RefreshTarget>() });
    return Promise.resolve(report);
  };
  return { run, calls };
}

// Mount both endpoints with injected build + refresh runners. The build runner
// defaults to a canned success so refresh-only tests don't care about it.
function appRefresh(
  runRefresh: LockRefreshRunner,
  runBuild: ProductionBuildRunner = captureRunner(successReport()).run,
  kernel?: Kernel,
): Hono {
  const a = new Hono();
  mountProductionRoutes(a, fakeCore(kernel), runBuild, runRefresh);
  return a;
}

async function postRefresh(a: Hono, body?: unknown): Promise<Response> {
  return await a.request("/api/production/lock-refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function pollRefresh(a: Hono, id: string): Promise<LockRefreshJob> {
  for (let i = 0; i < 50; i++) {
    const res = await a.request(`/api/production/lock-refresh/${id}`);
    const job = await res.json() as LockRefreshJob;
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("refresh job did not settle");
}

Deno.test("refresh: POST with no body mints a both-targets job; poll yields the projected DTO", async () => {
  const captured = captureRefreshRunner(refreshReport());
  const a = appRefresh(captured.run);

  const postRes = await postRefresh(a);
  assertEquals(postRes.status, 202);
  const posted = await postRes.json() as LockRefreshJob;
  assertEquals(posted.status, "running");
  assert(posted.id.startsWith("lockref_"), "id has the lockref_ prefix");
  // Omitted targets → both, in canonical order.
  assertEquals(posted.targets, ["deno-source", "node"]);
  assert(typeof posted.startedAt === "string" && posted.startedAt.length > 0);

  const job = await pollRefresh(a, posted.id);
  assertEquals(job.status, "done");
  assert(typeof job.completedAt === "string");
  assertEquals(job.result?.ok, true);
  assertEquals(job.result?.targets.map((t) => t.target), [
    "deno-source",
    "node",
  ]);
  assertEquals(job.result?.targets.map((t) => t.status), [
    "refreshed",
    "refreshed",
  ]);

  // The runner saw the default both-target set.
  assertEquals(captured.calls.length, 1);
  assertEquals([...captured.calls[0]!.targets].sort(), ["deno-source", "node"]);
});

Deno.test("refresh: explicit single target reaches the runner and the envelope", async () => {
  const captured = captureRefreshRunner({
    ok: true,
    targets: [{
      target: TARGET_DENO_SOURCE,
      status: "refreshed",
      detail: "ok",
    }],
  });
  const a = appRefresh(captured.run);
  const posted = await (await postRefresh(a, { targets: ["deno-source"] }))
    .json() as LockRefreshJob;

  assertEquals(posted.targets, ["deno-source"]);
  const job = await pollRefresh(a, posted.id);
  assertEquals(job.status, "done");
  assertEquals(captured.calls.length, 1);
  assertEquals([...captured.calls[0]!.targets], ["deno-source"]);
});

Deno.test("refresh: a failed target is a done result with ok false (not an error)", async () => {
  const a = appRefresh(captureRefreshRunner(refreshReport("failed")).run);
  const posted = await (await postRefresh(a)).json() as LockRefreshJob;
  const job = await pollRefresh(a, posted.id);

  assertEquals(job.status, "done");
  assertEquals(job.result?.ok, false);
  const nodeResult = job.result?.targets.find((t) => t.target === "node");
  assertEquals(nodeResult?.status, "failed");
  assertEquals(nodeResult?.code, "NODE_LOCK_REFRESH_FAILED");
});

Deno.test("refresh: an unexpected throw around the producer leaves the job in error", async () => {
  const run: LockRefreshRunner = () =>
    Promise.reject(new Error("export exploded"));
  const a = appRefresh(run);
  const posted = await (await postRefresh(a)).json() as LockRefreshJob;
  const job = await pollRefresh(a, posted.id);

  assertEquals(job.status, "error");
  assertEquals(job.error, "export exploded");
  assertEquals(job.result, undefined);
});

Deno.test("refresh: an unknown target is rejected 400 before any refresh starts", async () => {
  const captured = captureRefreshRunner(refreshReport());
  const a = appRefresh(captured.run);
  const res = await postRefresh(a, { targets: ["binary"] });
  assertEquals(res.status, 400);
  assert((await res.json()).error.includes("binary"));
  assertEquals(captured.calls.length, 0);
});

Deno.test("refresh: an explicit empty target set is rejected 400 (not a silent no-op)", async () => {
  const captured = captureRefreshRunner(refreshReport());
  const a = appRefresh(captured.run);
  const res = await postRefresh(a, { targets: [] });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "no valid refresh targets selected");
  assertEquals(captured.calls.length, 0);
});

Deno.test("refresh: no project loaded is 400", async () => {
  const kernel = {
    projectDir: null,
    log: { log: () => {} },
  } as unknown as Kernel;
  const a = appRefresh(
    captureRefreshRunner(refreshReport()).run,
    captureRunner(successReport()).run,
    kernel,
  );
  const res = await postRefresh(a);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "no project directory is loaded");
});

Deno.test("refresh: an unknown job id is 404", async () => {
  const a = appRefresh(captureRefreshRunner(refreshReport()).run);
  const res = await a.request("/api/production/lock-refresh/lockref_nope");
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error, "lock refresh job not found");
});

Deno.test("refresh: single-flight — a second refresh while one runs returns 409 naming the running id", async () => {
  let release!: (report: LockRefreshReport) => void;
  const gate = new Promise<LockRefreshReport>((r) => {
    release = r;
  });
  const run: LockRefreshRunner = () => gate;
  const a = appRefresh(run);

  const first = await (await postRefresh(a)).json() as LockRefreshJob;
  assertEquals(first.status, "running");

  const secondRes = await postRefresh(a);
  assertEquals(secondRes.status, 409);
  const second = await secondRes.json();
  assertEquals(second.error, "a lock refresh is already running");
  assertEquals(second.id, first.id);

  release(refreshReport());
  const done = await pollRefresh(a, first.id);
  assertEquals(done.status, "done");
});

// --- Cross-endpoint mutual exclusion (Slice 7.2 decision #2) -------------------

Deno.test("mutual exclusion: a build is refused 409 while a refresh runs", async () => {
  let release!: (report: LockRefreshReport) => void;
  const refreshGate = new Promise<LockRefreshReport>((r) => {
    release = r;
  });
  const runRefresh: LockRefreshRunner = () => refreshGate;
  const a = appRefresh(runRefresh, captureRunner(successReport()).run);

  const refresh = await (await postRefresh(a)).json() as LockRefreshJob;
  assertEquals(refresh.status, "running");

  // A build POST while the refresh is in flight is refused, naming the refresh.
  const buildRes = await postBuild(a);
  assertEquals(buildRes.status, 409);
  const buildBody = await buildRes.json();
  assertEquals(buildBody.error, "a lock refresh is already running");
  assertEquals(buildBody.id, refresh.id);

  release(refreshReport());
  await pollRefresh(a, refresh.id);
});

Deno.test("mutual exclusion: a refresh is refused 409 while a build runs", async () => {
  let release!: (report: ProductionBuildReport) => void;
  const buildGate = new Promise<ProductionBuildReport>((r) => {
    release = r;
  });
  const runBuild: ProductionBuildRunner = () => buildGate;
  const a = appRefresh(captureRefreshRunner(refreshReport()).run, runBuild);

  const build = await (await postBuild(a)).json() as ProductionBuildJob;
  assertEquals(build.status, "running");

  const refreshRes = await postRefresh(a);
  assertEquals(refreshRes.status, 409);
  const refreshBody = await refreshRes.json();
  assertEquals(refreshBody.error, "a production build is already running");
  assertEquals(refreshBody.id, build.id);

  release(successReport());
  await pollJob(a, build.id);
});

Deno.test("mutual exclusion: a refresh and a build can run one after the other", async () => {
  const a = appRefresh(
    captureRefreshRunner(refreshReport()).run,
    captureRunner(successReport()).run,
  );
  // Refresh to completion, then a build must be accepted (the shared lock released).
  const refresh = await (await postRefresh(a)).json() as LockRefreshJob;
  await pollRefresh(a, refresh.id);

  const buildRes = await postBuild(a);
  assertEquals(buildRes.status, 202);
  const build = await buildRes.json() as ProductionBuildJob;
  const doneBuild = await pollJob(a, build.id);
  assertEquals(doneBuild.status, "done");
});

// --- Slice 7.4: lock_refresh ledger attestations ------------------------------
// A refresh mints one lock_refresh attestation per REFRESHED target, fingerprinted
// to the committed lock's SHA-256. Skipped/failed targets attest nothing. The mint
// is best-effort — a ledger-write failure never flips the job's terminal state.

Deno.test("lockRefreshAttestationInputs: both refreshed → one lock_refresh per target, hash-fingerprinted", () => {
  const inputs = lockRefreshAttestationInputs(refreshReport());
  assertEquals(inputs.length, 2);
  for (const att of inputs) {
    assertEquals(att.kind, "lock_refresh");
    assertEquals(att.status, "passed");
    assertEquals(att.scope, PRODUCTION_SCOPE);
  }
  // The subject is the produced lock's content hash, not a source snapshot.
  assertEquals(inputs.map((i) => i.fingerprint).sort(), [
    "deno-sha",
    "node-sha",
  ]);
  assert(inputs.every((i) => i.summary.includes("sha256 ")));
});

Deno.test("lockRefreshAttestationInputs: a skipped target attests nothing", () => {
  const inputs = lockRefreshAttestationInputs(refreshReport("skipped"));
  assertEquals(inputs.length, 1);
  assertEquals(inputs[0]!.fingerprint, "deno-sha");
});

Deno.test("lockRefreshAttestationInputs: a failed target attests nothing (the refreshed sibling still does)", () => {
  const inputs = lockRefreshAttestationInputs(refreshReport("failed"));
  assertEquals(inputs.length, 1);
  assertEquals(inputs[0]!.fingerprint, "deno-sha");
});

Deno.test("lockRefreshAttestationInputs: no refreshed targets → nothing", () => {
  const report: LockRefreshReport = {
    ok: true,
    targets: [
      { target: TARGET_DENO_SOURCE, status: "skipped", detail: "not selected" },
      { target: TARGET_NODE, status: "skipped", detail: "toolchain absent" },
    ],
  };
  assertEquals(lockRefreshAttestationInputs(report), []);
});

Deno.test("refresh recording: a both-refreshed run writes two lock_refresh ledger rows", async () => {
  const sink = newSink();
  const a = appRefresh(
    captureRefreshRunner(refreshReport()).run,
    captureRunner(successReport()).run,
    fakeKernel({ sink }),
  );
  const posted = await (await postRefresh(a)).json() as LockRefreshJob;
  await pollRefresh(a, posted.id);

  // No active changeset → the synthetic sentinel ledger path.
  assertEquals(sink.attestations.length, 0);
  assertEquals(sink.ledger.map((e) => e.kind), [
    "lock_refresh",
    "lock_refresh",
  ]);
  assertEquals(
    sink.ledger.map((e) => e.fingerprint).sort(),
    ["deno-sha", "node-sha"],
  );
  for (const e of sink.ledger) {
    assertEquals(e.scope, PRODUCTION_SCOPE);
    assertEquals(e.changesetId, PRODUCTION_CHANGESET_ID);
    assertEquals(e.changesetTitle, PRODUCTION_CHANGESET_TITLE);
  }
});

Deno.test("refresh recording: an active in_progress changeset takes the changeset-scoped path", async () => {
  const sink = newSink();
  const active = { id: "cs-active", status: "in_progress" } as Changeset;
  const a = appRefresh(
    captureRefreshRunner(refreshReport()).run,
    captureRunner(successReport()).run,
    fakeKernel({ sink, active }),
  );
  const posted = await (await postRefresh(a)).json() as LockRefreshJob;
  await pollRefresh(a, posted.id);

  assertEquals(sink.ledger.length, 0);
  assertEquals(sink.attestations.length, 2);
  for (const { changesetId, att } of sink.attestations) {
    assertEquals(changesetId, "cs-active");
    assertEquals(att.kind, "lock_refresh");
  }
});

Deno.test("refresh recording: a failed node target attests only the refreshed deno lock", async () => {
  const sink = newSink();
  const a = appRefresh(
    captureRefreshRunner(refreshReport("failed")).run,
    captureRunner(successReport()).run,
    fakeKernel({ sink }),
  );
  const posted = await (await postRefresh(a)).json() as LockRefreshJob;
  const job = await pollRefresh(a, posted.id);

  assertEquals(job.result?.ok, false);
  assertEquals(sink.ledger.map((e) => e.fingerprint), ["deno-sha"]);
});

Deno.test("refresh recording is best-effort: a throwing ledger writer leaves the job done, not error", async () => {
  const a = appRefresh(
    captureRefreshRunner(refreshReport()).run,
    captureRunner(successReport()).run,
    fakeKernel({ throwOnRecord: true }),
  );
  const posted = await (await postRefresh(a)).json() as LockRefreshJob;
  const job = await pollRefresh(a, posted.id);

  assertEquals(job.status, "done");
  assertEquals(job.result?.ok, true);
  assertEquals(job.error, undefined);
});
