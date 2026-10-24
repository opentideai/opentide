import { assertEquals } from "@std/assert";
import { MANIFEST_PATH } from "../core/export.ts";
import {
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
  type ProductionBuildReport,
  TARGET_BINARY,
  TARGET_DENO_SOURCE,
  TARGET_NODE,
} from "./production-build.ts";
import type { ProductionTargetKey } from "../shared/production-build.ts";
import { projectProductionBuildReport } from "./production-build-report.ts";

// Slice 5.1 (docs/production-output-hardening-plan.md → Milestone 5):
// projectProductionBuildReport is pure, total, never-throws, and deterministic —
// it PROJECTS the orchestrator's ProductionBuildReport onto the serializable,
// target-grouped ProductionBuildResult wire DTO without re-running a gate or
// re-hashing a byte. The full pipeline is exercised over real boots by
// production-build_test.ts; here we prove the projection in isolation, no
// subprocess.

// --- Fixtures -----------------------------------------------------------------

function passed(gate: string, detail = `${gate} ok`): GateOutcome {
  return { gate, status: "passed", detail };
}

function failed(
  gate: string,
  code: string,
  detail = `${gate} failed`,
): GateOutcome {
  return { gate, status: "failed", code, detail };
}

function skipped(gate: string, detail = "skipped"): GateOutcome {
  return { gate, status: "skipped", detail };
}

// A fingerprint + file set as they would appear inside a real export's
// manifest.json. Kept small and explicit so the artifact assertions are exact.
const FINGERPRINT = "abc123def456";
const MANIFEST_FILES = [
  { path: "deno.json", sha256: "aaa", bytes: 42 },
  { path: "main.ts", sha256: "bbb", bytes: 100 },
];

// Build the manifest.json ExportFile the projection parses — byte-for-byte how
// generateManifest writes it (JSON.stringify(..., null, 2) + "\n"). Overridable
// content lets the malformed-manifest case inject garbage.
function manifestFile(content?: string) {
  const manifest = {
    formatVersion: 1,
    projectName: "Test App",
    projectVersion: "1.0.0",
    runtimeId: "typescript",
    exportOptions: {},
    files: MANIFEST_FILES,
    sourceFingerprint: FINGERPRINT,
    checks: [],
    artifacts: [],
  };
  return {
    path: MANIFEST_PATH,
    content: content ?? JSON.stringify(manifest, null, 2) + "\n",
  };
}

// A report whose artifact carries a well-formed manifest plus the two source
// files (the artifact is present only on a full pass, so callers pass ok: true).
function artifact(manifest = manifestFile()) {
  return {
    files: [
      { path: "deno.json", content: "{}" },
      { path: "main.ts", content: "export {};" },
      manifest,
    ],
    tarball: new Uint8Array([1, 2, 3]),
  };
}

// The ten gates of a default full-pass run: five deno-source core gates passed,
// dependency_lock self-skipped (no committed lock), node_dependency_lock/node/
// binary skipped (not selected), route_parity self-skipped (single target).
function fullPassGates(): GateOutcome[] {
  return [
    passed(GATE_MANIFEST),
    passed(GATE_DETERMINISM),
    passed(GATE_TYPE_CHECK),
    skipped(GATE_DEPENDENCY_LOCK, "no committed deno.lock to validate"),
    passed(GATE_APP_SMOKE),
    passed(GATE_DENO_SMOKE),
    skipped(GATE_NODE_DEPENDENCY_LOCK, "target not selected"),
    skipped(GATE_NODE_SMOKE, "target not selected"),
    skipped(GATE_BINARY_SMOKE, "target not selected"),
    skipped(GATE_ROUTE_PARITY, "route parity needs ≥2 probed targets"),
  ];
}

// --- Full-pass default run ----------------------------------------------------

Deno.test("projectProductionBuildReport: full-pass default run → passed, per-target rollups, artifact parsed", () => {
  const report: ProductionBuildReport = {
    ok: true,
    sourceFingerprint: FINGERPRINT,
    gates: fullPassGates(),
    artifact: artifact(),
  };
  const dto = projectProductionBuildReport(report);

  assertEquals(dto.ok, true);
  assertEquals(dto.status, "passed");
  assertEquals(dto.sourceFingerprint, FINGERPRINT);

  // Flat gates: a faithful 1:1 pipeline-ordered mirror — all 10, in order.
  assertEquals(dto.gates.length, 10);
  assertEquals(dto.gates.map((g) => g.gate), [
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

  // Per-target rollups, in fixed order: deno-source passed, node/binary skipped.
  assertEquals(dto.targets.map((t) => t.target), [
    TARGET_DENO_SOURCE,
    TARGET_NODE,
    TARGET_BINARY,
  ]);
  assertEquals(dto.targets.map((t) => t.status), [
    "passed",
    "skipped",
    "skipped",
  ]);
  // deno-source rollup: the five core gates plus the (skipped) dependency_lock —
  // a skipped gate among passed ones keeps the rollup "passed".
  assertEquals(dto.targets[0]!.gates.map((g) => g.gate), [
    GATE_MANIFEST,
    GATE_DETERMINISM,
    GATE_TYPE_CHECK,
    GATE_DEPENDENCY_LOCK,
    GATE_APP_SMOKE,
    GATE_DENO_SMOKE,
  ]);

  // Parity surfaced on its own, skipped, and still present in the flat list.
  assertEquals(dto.parity?.gate, GATE_ROUTE_PARITY);
  assertEquals(dto.parity?.status, "skipped");

  // Artifact is a pure manifest parse — fingerprint + per-file hashes.
  assertEquals(dto.artifact?.sourceFingerprint, FINGERPRINT);
  assertEquals(dto.artifact?.files, MANIFEST_FILES);
});

// --- Node-selected pass -------------------------------------------------------

Deno.test("projectProductionBuildReport: node-selected pass → node rollup passed, parity passed", () => {
  const report: ProductionBuildReport = {
    ok: true,
    sourceFingerprint: FINGERPRINT,
    gates: [
      passed(GATE_MANIFEST),
      passed(GATE_DETERMINISM),
      passed(GATE_TYPE_CHECK),
      passed(GATE_APP_SMOKE),
      passed(GATE_DENO_SMOKE),
      passed(GATE_NODE_DEPENDENCY_LOCK),
      passed(GATE_NODE_SMOKE),
      skipped(GATE_BINARY_SMOKE, "target not selected"),
      passed(GATE_ROUTE_PARITY, "Route parity holds across deno-source, node"),
    ],
    artifact: artifact(),
  };
  const dto = projectProductionBuildReport(report);

  assertEquals(dto.status, "passed");
  assertEquals(dto.targets.map((t) => t.status), [
    "passed",
    "passed",
    "skipped",
  ]);
  assertEquals(dto.targets[1]!.target, TARGET_NODE);
  // Both Node-scoped gates roll into the node target, in pipeline order.
  assertEquals(dto.targets[1]!.gates.map((g) => g.gate), [
    GATE_NODE_DEPENDENCY_LOCK,
    GATE_NODE_SMOKE,
  ]);
  assertEquals(dto.parity?.status, "passed");
});

// --- route_parity failure -----------------------------------------------------

Deno.test("projectProductionBuildReport: route_parity failure → failed, parity carries its code, no artifact", () => {
  const report: ProductionBuildReport = {
    ok: false,
    sourceFingerprint: FINGERPRINT,
    gates: [
      passed(GATE_MANIFEST),
      passed(GATE_DETERMINISM),
      passed(GATE_TYPE_CHECK),
      passed(GATE_APP_SMOKE),
      passed(GATE_DENO_SMOKE),
      passed(GATE_NODE_SMOKE),
      skipped(GATE_BINARY_SMOKE, "target not selected"),
      failed(
        GATE_ROUTE_PARITY,
        "EXPORT_ROUTE_PARITY_FAILED",
        "GET /orders body differs",
      ),
    ],
    // No artifact — a failing build never carries one.
  };
  const dto = projectProductionBuildReport(report);

  assertEquals(dto.ok, false);
  assertEquals(dto.status, "failed");
  assertEquals(dto.parity?.status, "failed");
  assertEquals(dto.parity?.code, "EXPORT_ROUTE_PARITY_FAILED");
  assertEquals(dto.parity?.detail, "GET /orders body differs");
  assertEquals(dto.artifact, null);
  // The failed parity gate is faithfully mirrored in the flat checklist too.
  assertEquals(dto.gates.at(-1)?.status, "failed");
});

// --- routeSmoke diagnostics ---------------------------------------------------

Deno.test("projectProductionBuildReport: routeSmoke warning details cross the wire", () => {
  const report: ProductionBuildReport = {
    ok: true,
    sourceFingerprint: FINGERPRINT,
    gates: fullPassGates(),
    routeSmoke: {
      status: "warning",
      routesProbed: 2,
      routesFailed: 1,
      skipped: 3,
      failures: [{
        target: TARGET_DENO_SOURCE,
        method: "GET",
        path: "/orders",
        expectedStatus: 200,
        actualStatus: 500,
        detail: "GET /orders returned a server error 500. Response body: boom",
        bodySnippet: "boom",
      }],
    },
    artifact: artifact(),
  };
  const dto = projectProductionBuildReport(report);

  assertEquals(dto.ok, true);
  assertEquals(dto.routeSmoke?.status, "warning");
  assertEquals(dto.routeSmoke?.routesProbed, 2);
  assertEquals(dto.routeSmoke?.routesFailed, 1);
  assertEquals(dto.routeSmoke?.skipped, 3);
  assertEquals(dto.routeSmoke?.failures[0]?.target, TARGET_DENO_SOURCE);
  assertEquals(dto.routeSmoke?.failures[0]?.bodySnippet, "boom");
});

// --- Stop-at-first-failure truncation -----------------------------------------

Deno.test("projectProductionBuildReport: type_check failure truncates tail → only deno-source rollup, no fabricated targets", () => {
  const report: ProductionBuildReport = {
    ok: false,
    sourceFingerprint: FINGERPRINT,
    gates: [
      passed(GATE_MANIFEST),
      passed(GATE_DETERMINISM),
      failed(GATE_TYPE_CHECK, "EXPORT_TYPE_CHECK_FAILED"),
    ],
  };
  const dto = projectProductionBuildReport(report);

  assertEquals(dto.status, "failed");
  // Only deno-source ran; node/binary/parity are absent, never fabricated.
  assertEquals(dto.targets.map((t) => t.target), [TARGET_DENO_SOURCE]);
  assertEquals(dto.targets[0]!.status, "failed");
  assertEquals(dto.targets[0]!.gates.map((g) => g.gate), [
    GATE_MANIFEST,
    GATE_DETERMINISM,
    GATE_TYPE_CHECK,
  ]);
  assertEquals(dto.parity, null);
  assertEquals(dto.artifact, null);
  assertEquals(dto.gates.length, 3);
});

// --- Malformed / missing manifest degrades to null (never throws) -------------

Deno.test("projectProductionBuildReport: artifact present but manifest.json absent → artifact null, no throw", () => {
  const report: ProductionBuildReport = {
    ok: true,
    sourceFingerprint: FINGERPRINT,
    gates: fullPassGates(),
    artifact: {
      // No manifest.json among the files.
      files: [{ path: "main.ts", content: "export {};" }],
      tarball: new Uint8Array(),
    },
  };
  assertEquals(projectProductionBuildReport(report).artifact, null);
});

Deno.test("projectProductionBuildReport: unparseable manifest → artifact null, no throw", () => {
  const report: ProductionBuildReport = {
    ok: true,
    sourceFingerprint: FINGERPRINT,
    gates: fullPassGates(),
    artifact: artifact(manifestFile("{ not valid json ]")),
  };
  assertEquals(projectProductionBuildReport(report).artifact, null);
});

Deno.test("projectProductionBuildReport: manifest missing required fields → artifact null, no throw", () => {
  const report: ProductionBuildReport = {
    ok: true,
    sourceFingerprint: FINGERPRINT,
    gates: fullPassGates(),
    // Valid JSON, but files[] entries lack sha256/bytes.
    artifact: artifact(manifestFile(
      JSON.stringify({
        sourceFingerprint: FINGERPRINT,
        files: [{ path: "x" }],
      }),
    )),
  };
  assertEquals(projectProductionBuildReport(report).artifact, null);
});

// --- Target-key alignment pin -------------------------------------------------

Deno.test("ProductionTargetKey literals match the TARGET_* constants (single source of truth)", () => {
  // Compile-time: each TARGET_* constant must be assignable to ProductionTargetKey.
  const deno: ProductionTargetKey = TARGET_DENO_SOURCE;
  const node: ProductionTargetKey = TARGET_NODE;
  const binary: ProductionTargetKey = TARGET_BINARY;
  // Runtime: the literal strings themselves.
  assertEquals([deno, node, binary], ["deno-source", "node", "binary"]);
});

// --- Determinism --------------------------------------------------------------

Deno.test("projectProductionBuildReport: same report → byte-identical DTO", () => {
  const report: ProductionBuildReport = {
    ok: true,
    sourceFingerprint: FINGERPRINT,
    gates: fullPassGates(),
    artifact: artifact(),
  };
  assertEquals(
    JSON.stringify(projectProductionBuildReport(report)),
    JSON.stringify(projectProductionBuildReport(report)),
  );
});

// --- null sourceFingerprint passes through ------------------------------------

Deno.test("projectProductionBuildReport: a report whose manifest gate never succeeded → null sourceFingerprint", () => {
  const report: ProductionBuildReport = {
    ok: false,
    sourceFingerprint: null,
    gates: [failed(GATE_MANIFEST, "MANIFEST_MISSING")],
  };
  const dto = projectProductionBuildReport(report);
  assertEquals(dto.sourceFingerprint, null);
  assertEquals(dto.status, "failed");
  assertEquals(dto.targets[0]!.status, "failed");
});
