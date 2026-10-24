import { assert, assertEquals } from "@std/assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Kernel } from "./registries.ts";
import { Database } from "./db.ts";
import {
  buildEpisode,
  computeSurvivalObservations,
  entitySurvivalRate,
  EPISODE_SCHEMA_VERSION,
  featuresFor,
  mapActionToOp,
  statusToHumanDecision,
  summarizeVerification,
  type SurvivalObservation,
  type VerificationEpisode,
} from "./episodes.ts";
import { blastRadiusReport, buildKnowledgeGraph } from "./knowledge-graph.ts";
import type { ChangeRecord } from "../shared/changelog.ts";
import type { Attestation, Changeset } from "../shared/verification.ts";

const testOpts = { sanitizeResources: false, sanitizeOps: false };

// A file-backed kernel over a fresh temp historyDir, so episodes.jsonl / survival
// .jsonl actually land on disk (no mocks — the whole point of A4 is the real file).
async function fileKernel(
  historyDir: string,
): Promise<{ kernel: Kernel; db: Database }> {
  mkdirSync(historyDir, { recursive: true });
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db, { historyDir });
  return { kernel, db };
}

const noopFn = () => undefined;

// Register a function entity so entityUidFor resolves a uid, then return that uid.
function registerFn(
  kernel: Kernel,
  name: string,
  source: string,
  entityUid?: string,
): string {
  kernel.functions.register(
    name,
    source,
    noopFn,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    entityUid,
  );
  return kernel.functions.getEntry(name)!.entityUid;
}

// Drive a change through the changelog facade, which stamps entityUid (A2) and
// fires the A4 emit hook. `origin` sets A1's authorOrigin.
async function record(
  kernel: Kernel,
  entry: {
    category: ChangeRecord["category"];
    key: string;
    action: ChangeRecord["action"];
    beforeSnapshot: unknown;
    afterSnapshot: unknown;
    origin?: "ai" | "human";
    renamedFrom?: string;
    userMessage?: string;
  },
): Promise<void> {
  await kernel.changelog.record({
    category: entry.category,
    key: entry.key,
    action: entry.action,
    beforeSnapshot: entry.beforeSnapshot,
    afterSnapshot: entry.afterSnapshot,
    context: {
      ...(entry.origin ? { authorOrigin: entry.origin } : {}),
      ...(entry.renamedFrom ? { renamedFrom: entry.renamedFrom } : {}),
      ...(entry.userMessage ? { userMessage: entry.userMessage } : {}),
      sessionId: "sess_test",
    },
  });
}

function readEpisodesRaw(historyDir: string): VerificationEpisode[] {
  const path = join(historyDir, "episodes.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).map((
    l,
  ) => JSON.parse(l) as VerificationEpisode);
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  const raw = readFileSync(path, "utf-8").trim();
  return raw ? raw.split("\n").length : 0;
}

// --- Pure helper unit tests (no kernel, no I/O) ---

Deno.test("mapActionToOp maps structural ops and skips execute/restore", () => {
  assertEquals(mapActionToOp("create"), "create");
  assertEquals(mapActionToOp("update"), "update");
  assertEquals(mapActionToOp("delete"), "delete");
  assertEquals(mapActionToOp("rename"), "rename");
  assertEquals(mapActionToOp("execute"), null);
  assertEquals(mapActionToOp("restore"), null);
});

Deno.test("featuresFor derives sizes locally; prev null on create", () => {
  const create = featuresFor({
    beforeSnapshot: null,
    afterSnapshot: { name: "f", source: "abcde" },
  } as ChangeRecord);
  assertEquals(create.sourceBytes, 5);
  assertEquals(create.sourceLines, 1);
  assertEquals(create.prevSourceBytes, null);
  assertEquals(create.changedBytes, 5);
  assertEquals(create.inDegree, null); // graph fields reserved until B1

  const update = featuresFor({
    beforeSnapshot: { name: "f", source: "abcde" },
    afterSnapshot: { name: "f", source: "abcdefghij" },
  } as ChangeRecord);
  assertEquals(update.sourceBytes, 10);
  assertEquals(update.prevSourceBytes, 5);
  assertEquals(update.changedBytes, 5);

  const del = featuresFor({
    beforeSnapshot: { name: "f", source: "abcde" },
    afterSnapshot: null,
  } as ChangeRecord);
  assertEquals(del.sourceBytes, 0);
  assertEquals(del.prevSourceBytes, 5);
  assertEquals(del.changedBytes, 5);
});

Deno.test("B1b: featuresFor computes edgeDelta from source; degrees default null", () => {
  // create — before ∅, after has one out-edge → edgeDelta 1; degrees stay null
  // (they are graph-node-only, filled by buildEpisode when a graph is supplied).
  const create = featuresFor({
    beforeSnapshot: null,
    afterSnapshot: { name: "f", source: 'functions.call("a")' },
  } as ChangeRecord);
  assertEquals(create.edgeDelta, 1);
  assertEquals(create.inDegree, null);
  assertEquals(create.outDegree, null);
  assertEquals(create.dependentCount, null);

  // update adding a second distinct out-edge → edgeDelta 1 (one edge added)
  const update = featuresFor({
    beforeSnapshot: { name: "f", source: 'functions.call("a")' },
    afterSnapshot: {
      name: "f",
      source: 'functions.call("a"); config.get("b")',
    },
  } as ChangeRecord);
  assertEquals(update.edgeDelta, 1);

  // delete — after ∅ → edgeDelta = removed-edge count
  const del = featuresFor({
    beforeSnapshot: { name: "f", source: 'functions.call("a")' },
    afterSnapshot: null,
  } as ChangeRecord);
  assertEquals(del.edgeDelta, 1);

  // whitespace-only churn (same out-edge set) → 0
  const noop = featuresFor({
    beforeSnapshot: { name: "f", source: 'functions.call("a")' },
    afterSnapshot: { name: "f", source: '  functions.call("a")  ' },
  } as ChangeRecord);
  assertEquals(noop.edgeDelta, 0);
});

Deno.test("B1b: buildEpisode merges a supplied graph over featuresFor's null degrees", () => {
  const rec = {
    category: "function",
    key: "f",
    action: "create",
    beforeSnapshot: null,
    afterSnapshot: { name: "f", source: 'functions.call("a")' },
    createdAt: "2026-07-28T00:00:00.000Z",
    turnId: null,
    changesetId: null,
    context: { sessionId: "s1" },
  } as ChangeRecord;

  // No graph → degrees stay null, edgeDelta still computed from source.
  const bare = buildEpisode({
    record: rec,
    op: "create",
    authorOrigin: "ai",
    entityUid: "ent_1",
    verification: summarizeVerification(null),
    humanDecision: null,
  });
  assertEquals(bare.features.inDegree, null);
  assertEquals(bare.features.edgeDelta, 1);

  // Graph supplied → its degrees override the nulls; edgeDelta is untouched.
  const enriched = buildEpisode({
    record: rec,
    op: "create",
    authorOrigin: "ai",
    entityUid: "ent_1",
    verification: summarizeVerification(null),
    humanDecision: null,
    graph: { inDegree: 2, outDegree: 3, dependentCount: 5 },
  });
  assertEquals(enriched.features.inDegree, 2);
  assertEquals(enriched.features.outDegree, 3);
  assertEquals(enriched.features.dependentCount, 5);
  assertEquals(enriched.features.edgeDelta, 1);
});

Deno.test("summarizeVerification reduces attestations to counts + kinds", () => {
  assertEquals(summarizeVerification(null).outcome, "none");
  assertEquals(summarizeVerification(null).ran, false);

  const atts: Attestation[] = [
    {
      id: "a1",
      kind: "test",
      status: "passed",
      fingerprint: "f",
      scope: "function:x",
      summary: "3 passed",
      createdAt: "2026-07-28T00:00:00.000Z",
    },
    {
      id: "a2",
      kind: "typecheck",
      status: "passed",
      fingerprint: "f",
      scope: "project",
      summary: "ok",
      createdAt: "2026-07-28T00:00:01.000Z",
    },
  ];
  const cs = { plan: { attestations: atts } } as Changeset;
  const v = summarizeVerification(cs);
  assertEquals(v.ran, true);
  assertEquals(v.outcome, "passed");
  assertEquals(v.testsPassed, 1);
  assertEquals(v.testsFailed, 0);
  assertEquals(v.typecheckOk, true);
  assertEquals(v.attestationKinds, ["test", "typecheck"]);
  assertEquals(v.lintErrors, null); // reserved until D3
});

Deno.test("statusToHumanDecision folds changeset status", () => {
  assertEquals(statusToHumanDecision("completed"), "accepted");
  assertEquals(statusToHumanDecision("approved"), "accepted");
  assertEquals(statusToHumanDecision("rejected"), "rejected");
  assertEquals(statusToHumanDecision("abandoned"), "rejected");
  assertEquals(statusToHumanDecision("in_progress"), "pending");
  assertEquals(statusToHumanDecision(null), null);
});

Deno.test("buildEpisode never carries source/free-text; only numbers + ids", () => {
  const rec = {
    id: 1,
    category: "function",
    key: "secretName",
    action: "create",
    beforeSnapshot: null,
    afterSnapshot: { name: "secretName", source: "SENSITIVE_SOURCE_TEXT" },
    context: {
      entityUid: "ent_1",
      authorOrigin: "ai",
      sessionId: "s1",
      userMessage: "PRIVATE_USER_MESSAGE",
      renamedFrom: "OLD_SECRET_NAME",
    },
    createdAt: "2026-07-28T00:00:00.000Z",
    undoable: true,
    turnId: "turn_1",
    changesetId: null,
    rationale: null,
    implementation: null,
    workMessageId: null,
  } as ChangeRecord;
  const ep = buildEpisode({
    record: rec,
    op: "create",
    authorOrigin: "ai",
    entityUid: "ent_1",
    verification: summarizeVerification(null),
    humanDecision: null,
  });
  const text = JSON.stringify(ep);
  assert(!text.includes("SENSITIVE_SOURCE_TEXT"));
  assert(!text.includes("PRIVATE_USER_MESSAGE"));
  assert(!text.includes("OLD_SECRET_NAME"));
  assertEquals(ep.features.sourceBytes, "SENSITIVE_SOURCE_TEXT".length);
  assertEquals(ep.schemaVersion, EPISODE_SCHEMA_VERSION);
});

Deno.test("computeSurvivalObservations reports lifecycle per uid", () => {
  const eps: VerificationEpisode[] = [
    makeEp("ent_A", "create", "ai", 100, null, "2026-07-01T00:00:00.000Z"),
    makeEp("ent_A", "update", "human", 120, 20, "2026-07-05T00:00:00.000Z"),
    makeEp("ent_B", "create", "ai", 50, null, "2026-07-10T00:00:00.000Z"),
  ];
  const now = Date.parse("2026-07-11T00:00:00.000Z");
  const obs = computeSurvivalObservations(eps, new Set(["ent_A"]), now);
  const a = obs.find((o) => o.entityUid === "ent_A")!;
  const b = obs.find((o) => o.entityUid === "ent_B")!;

  assertEquals(a.alive, true);
  assertEquals(a.modificationCount, 1);
  assertEquals(a.modifiedSinceAuthoring, true);
  assertEquals(a.authoringOrigin, "ai");
  assertEquals(a.modificationDepth, 20 / 100);
  assertEquals(a.ageDays, 10);

  assertEquals(b.alive, false); // not in the live set → reported as dead
  assertEquals(b.modificationCount, 0);
  assertEquals(b.authoringOrigin, "ai");
});

function makeEp(
  entityUid: string,
  op: VerificationEpisode["op"],
  origin: "ai" | "human",
  sourceBytes: number,
  changedBytes: number | null,
  occurredAt: string,
): VerificationEpisode {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: `epi_${entityUid}_${occurredAt}`,
    entityUid,
    category: "function",
    op,
    authorOrigin: origin,
    occurredAt,
    turnId: null,
    changesetId: null,
    sessionId: null,
    stepId: null,
    features: {
      sourceBytes,
      sourceLines: 1,
      prevSourceBytes: changedBytes === null
        ? null
        : sourceBytes - changedBytes,
      changedBytes,
      inDegree: null,
      outDegree: null,
      dependentCount: null,
      edgeDelta: null,
    },
    verification: summarizeVerification(null),
    humanDecision: null,
  };
}

// --- Integration tests (real file-backed kernel) ---

Deno.test(testOpts, async function createThenUpdateWritesTwoEpisodesOneUid() {
  const dir = await Deno.makeTempDir({ prefix: "episodes_" });
  const { kernel, db } = await fileKernel(dir);
  try {
    const uid = registerFn(kernel, "greet", "return 1");
    await record(kernel, {
      category: "function",
      key: "greet",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "greet", source: "return 1" },
      origin: "ai",
    });
    // Re-register (preserves uid) then update.
    registerFn(kernel, "greet", "return 100");
    await record(kernel, {
      category: "function",
      key: "greet",
      action: "update",
      beforeSnapshot: { name: "greet", source: "return 1" },
      afterSnapshot: { name: "greet", source: "return 100" },
      origin: "ai",
    });

    const eps = readEpisodesRaw(dir);
    assertEquals(eps.length, 2);
    assertEquals(eps[0]!.entityUid, uid);
    assertEquals(eps[1]!.entityUid, uid); // one uid threads the lifecycle
    assertEquals(eps[0]!.op, "create");
    assertEquals(eps[1]!.op, "update");
    assertEquals(eps[0]!.authorOrigin, "ai");
    assertEquals(eps[0]!.features.prevSourceBytes, null);
    assertEquals(eps[0]!.features.sourceBytes, "return 1".length);
    assertEquals(eps[1]!.features.prevSourceBytes, "return 1".length);
    assertEquals(eps[1]!.features.sourceBytes, "return 100".length);
    assert(eps[1]!.features.changedBytes! > 0);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test(testOpts, async function renameWritesOneRenameEpisodePreservingUid() {
  const dir = await Deno.makeTempDir({ prefix: "episodes_" });
  const { kernel, db } = await fileKernel(dir);
  try {
    const uid = registerFn(kernel, "foo", "return 1");
    await record(kernel, {
      category: "function",
      key: "foo",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "foo", source: "return 1" },
      origin: "ai",
    });
    // A3-shaped rename: new key inherits the uid, old key vacated, ONE rename record.
    registerFn(kernel, "bar", "return 1", uid);
    kernel.functions.remove("foo");
    await record(kernel, {
      category: "function",
      key: "bar",
      action: "rename",
      beforeSnapshot: { name: "foo", source: "return 1" },
      afterSnapshot: { name: "bar", source: "return 1" },
      origin: "human",
      renamedFrom: "foo",
    });

    const eps = readEpisodesRaw(dir);
    const renames = eps.filter((e) => e.op === "rename");
    assertEquals(renames.length, 1); // exactly one rename episode, not create+delete
    assertEquals(renames[0]!.entityUid, uid); // preserved across the name change
    assert(!eps.some((e) => e.op === "delete"));
    assertEquals(eps.length, 2); // create + rename only
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test(testOpts, async function episodeFileGrowsByAppend() {
  const dir = await Deno.makeTempDir({ prefix: "episodes_" });
  const { kernel, db } = await fileKernel(dir);
  const path = join(dir, "episodes.jsonl");
  try {
    registerFn(kernel, "a", "x");
    await record(kernel, {
      category: "function",
      key: "a",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "a", source: "x" },
      origin: "ai",
    });
    assertEquals(countLines(path), 1);
    const firstLine = readFileSync(path, "utf-8").split("\n")[0];

    registerFn(kernel, "b", "y");
    await record(kernel, {
      category: "function",
      key: "b",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "b", source: "y" },
      origin: "ai",
    });
    assertEquals(countLines(path), 2); // N → N+1
    // The first line is byte-for-byte unchanged: appended, never rewritten.
    assertEquals(readFileSync(path, "utf-8").split("\n")[0], firstLine);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test(testOpts, async function observeSurvivalAppendsOnePerLiveEntity() {
  const dir = await Deno.makeTempDir({ prefix: "episodes_" });
  const { kernel, db } = await fileKernel(dir);
  try {
    registerFn(kernel, "alive1", "a");
    await record(kernel, {
      category: "function",
      key: "alive1",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "alive1", source: "a" },
      origin: "ai",
    });
    registerFn(kernel, "alive2", "bb");
    await record(kernel, {
      category: "function",
      key: "alive2",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "alive2", source: "bb" },
      origin: "human",
    });

    const now = Date.parse("2026-07-28T00:00:00.000Z");
    kernel.observeSurvival(now);

    const survivalPath = join(dir, "survival.jsonl");
    const obs = readFileSync(survivalPath, "utf-8").trim().split("\n").map((
      l,
    ) => JSON.parse(l) as SurvivalObservation);
    assertEquals(obs.length, 2); // one per live entity
    const byUid = new Map(obs.map((o) => [o.entityUid, o]));
    const uid1 = kernel.functions.getEntry("alive1")!.entityUid;
    const uid2 = kernel.functions.getEntry("alive2")!.entityUid;
    assertEquals(byUid.get(uid1)!.alive, true);
    assertEquals(byUid.get(uid1)!.authoringOrigin, "ai");
    assertEquals(byUid.get(uid1)!.modificationCount, 0);
    assertEquals(byUid.get(uid2)!.authoringOrigin, "human");
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test(testOpts, async function privacyInvariantNoSourceOrFreeTextOnDisk() {
  const dir = await Deno.makeTempDir({ prefix: "episodes_" });
  const { kernel, db } = await fileKernel(dir);
  try {
    const SRC = "SENTINEL_SOURCE_abcxyz";
    const MSG = "SENTINEL_USER_MESSAGE_qwerty";
    const uid = registerFn(kernel, "orig", SRC);
    await record(kernel, {
      category: "function",
      key: "orig",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "orig", source: SRC },
      origin: "ai",
      userMessage: MSG,
    });
    registerFn(kernel, "renamed", SRC, uid);
    kernel.functions.remove("orig");
    await record(kernel, {
      category: "function",
      key: "renamed",
      action: "rename",
      beforeSnapshot: { name: "orig", source: SRC },
      afterSnapshot: { name: "renamed", source: SRC },
      origin: "human",
      renamedFrom: "orig", // a local-only entity name — must never reach an episode
    });
    kernel.observeSurvival(Date.now());

    for (const file of ["episodes.jsonl", "survival.jsonl"]) {
      const text = readFileSync(join(dir, file), "utf-8");
      assert(!text.includes(SRC), `${file} leaked source`);
      assert(!text.includes(MSG), `${file} leaked userMessage`);
      assert(!text.includes("renamedFrom"), `${file} leaked renamedFrom`);
      assert(!text.includes("beforeSnapshot"), `${file} leaked a snapshot`);
      assert(!text.includes(dir), `${file} leaked a path`);
    }

    // B1b: the graph features are NUMBERS or null — never a string (a leaked name /
    // target id would surface as a string). The graph may reference entity names
    // in-memory; only degrees/deltas may land on disk.
    for (const ep of readEpisodesRaw(dir)) {
      for (
        const field of [
          "inDegree",
          "outDegree",
          "dependentCount",
          "edgeDelta",
        ] as const
      ) {
        const v = ep.features[field];
        assert(
          v === null || typeof v === "number",
          `${field} must be number|null, got ${typeof v}`,
        );
      }
    }
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test(testOpts, async function streamAExitTestOneUidThreadsFullLifecycle() {
  const dir = await Deno.makeTempDir({ prefix: "episodes_" });
  const { kernel, db } = await fileKernel(dir);
  try {
    // create (ai)
    const uid = registerFn(kernel, "alpha", "return 1");
    await record(kernel, {
      category: "function",
      key: "alpha",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "alpha", source: "return 1" },
      origin: "ai",
    });
    // rename → beta (human)
    registerFn(kernel, "beta", "return 1", uid);
    kernel.functions.remove("alpha");
    await record(kernel, {
      category: "function",
      key: "beta",
      action: "rename",
      beforeSnapshot: { name: "alpha", source: "return 1" },
      afterSnapshot: { name: "beta", source: "return 1" },
      origin: "human",
      renamedFrom: "alpha",
    });
    // hand-edit (human)
    registerFn(kernel, "beta", "return 2");
    await record(kernel, {
      category: "function",
      key: "beta",
      action: "update",
      beforeSnapshot: { name: "beta", source: "return 1" },
      afterSnapshot: { name: "beta", source: "return 2" },
      origin: "human",
    });
    // delete (ai)
    kernel.functions.remove("beta");
    await record(kernel, {
      category: "function",
      key: "beta",
      action: "delete",
      beforeSnapshot: { name: "beta", source: "return 2" },
      afterSnapshot: null,
      origin: "ai",
    });

    const eps = readEpisodesRaw(dir);
    assertEquals(eps.length, 4);
    // A single entityUid threads all four episodes.
    assertEquals(new Set(eps.map((e) => e.entityUid)).size, 1);
    assertEquals(eps[0]!.entityUid, uid);
    assertEquals(eps.map((e) => e.op), [
      "create",
      "rename",
      "update",
      "delete",
    ]);
    assertEquals(eps.map((e) => e.authorOrigin), [
      "ai",
      "human",
      "human",
      "ai",
    ]);

    // The survival pass reports the lifecycle: dead (deleted), thrice modified,
    // AI-authored.
    kernel.observeSurvival(Date.now());
    const obs = readFileSync(join(dir, "survival.jsonl"), "utf-8").trim().split(
      "\n",
    ).map((l) => JSON.parse(l) as SurvivalObservation);
    const mine = obs.filter((o) => o.entityUid === uid);
    assertEquals(mine.length, 1);
    assertEquals(mine[0]!.alive, false);
    assertEquals(mine[0]!.authoringOrigin, "ai");
    assertEquals(mine[0]!.modificationCount, 3);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test(testOpts, async function dbOnlyKernelHasNoEpisodeLogAndNoOps() {
  const db = await Database.create({ driver: "pglite" });
  const kernel = new Kernel(db); // no historyDir → DB-only test mode
  try {
    assertEquals(kernel.episodeLog, null);
    registerFn(kernel, "x", "return 1");
    // Recording a change must not throw despite no episode log wired.
    await record(kernel, {
      category: "function",
      key: "x",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "x", source: "return 1" },
      origin: "ai",
    });
    kernel.observeSurvival(Date.now()); // no-op, must not throw
  } finally {
    await db.close();
  }
});

// --- Stream B / B1b: episode graph features (degrees from the after-graph;
// edgeDelta from before/after out-edge churn). Real file-backed kernel, no mocks. ---

Deno.test(testOpts, async function b1bDegreesPopulatedFromAfterGraph() {
  const dir = await Deno.makeTempDir({ prefix: "episodes_b1b_" });
  const { kernel, db } = await fileKernel(dir);
  try {
    // fnB exists; fnA calls it. At fnA's create the after-graph gives fnA outDegree
    // ≥ 1 (it references fnB) but inDegree 0 (nothing depends on fnA yet).
    registerFn(kernel, "fnB", "function fnB(){ return 1; }");
    await record(kernel, {
      category: "function",
      key: "fnB",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "fnB", source: "function fnB(){ return 1; }" },
      origin: "ai",
    });
    const fnASrc = 'function fnA(){ return functions.call("fnB"); }';
    registerFn(kernel, "fnA", fnASrc);
    await record(kernel, {
      category: "function",
      key: "fnA",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "fnA", source: fnASrc },
      origin: "ai",
    });

    const fnAUid = kernel.functions.getEntry("fnA")!.entityUid;
    const create = readEpisodesRaw(dir).find((e) =>
      e.entityUid === fnAUid && e.op === "create"
    )!;
    assert(
      create.features.outDegree !== null && create.features.outDegree >= 1,
    );
    assertEquals(create.features.inDegree, 0);
    assertEquals(create.features.dependentCount, 0);

    // A later handler depends on fnA. Editing fnA → its NEXT episode sees the inbound
    // edge: non-null inDegree and dependentCount now that something points at it.
    kernel.handlers.register(
      "h",
      'async function h(c){ return functions.call("fnA"); }',
      () => Promise.resolve(new Response()),
      undefined,
      "m",
    );
    const fnASrc2 = 'function fnA(){ return functions.call("fnB") + 1; }';
    registerFn(kernel, "fnA", fnASrc2);
    await record(kernel, {
      category: "function",
      key: "fnA",
      action: "update",
      beforeSnapshot: { name: "fnA", source: fnASrc },
      afterSnapshot: { name: "fnA", source: fnASrc2 },
      origin: "ai",
    });

    const update = readEpisodesRaw(dir).find((e) =>
      e.entityUid === fnAUid && e.op === "update"
    )!;
    assert(update.features.inDegree !== null && update.features.inDegree >= 1);
    assert(
      update.features.dependentCount !== null &&
        update.features.dependentCount >= 1,
    );
    assert(
      update.features.outDegree !== null && update.features.outDegree >= 1,
    );
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test(testOpts, async function b1bEdgeDeltaOnUpdate() {
  const dir = await Deno.makeTempDir({ prefix: "episodes_b1b_" });
  const { kernel, db } = await fileKernel(dir);
  try {
    const src0 = "return 1"; // no out-edges
    registerFn(kernel, "e", src0);
    await record(kernel, {
      category: "function",
      key: "e",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "e", source: src0 },
      origin: "ai",
    });

    const src1 = 'return functions.call("dep")'; // adds one out-edge
    registerFn(kernel, "e", src1);
    await record(kernel, {
      category: "function",
      key: "e",
      action: "update",
      beforeSnapshot: { name: "e", source: src0 },
      afterSnapshot: { name: "e", source: src1 },
      origin: "ai",
    });

    const src2 = 'return functions.call("dep")   '; // whitespace only — same edges
    registerFn(kernel, "e", src2);
    await record(kernel, {
      category: "function",
      key: "e",
      action: "update",
      beforeSnapshot: { name: "e", source: src1 },
      afterSnapshot: { name: "e", source: src2 },
      origin: "ai",
    });

    const eps = readEpisodesRaw(dir);
    assertEquals(eps[0]!.features.edgeDelta, 0); // create with no out-edges
    assertEquals(eps[1]!.features.edgeDelta, 1); // one edge added
    assertEquals(eps[2]!.features.edgeDelta, 0); // no-op edit
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test(
  testOpts,
  async function b1bDeleteYieldsNullDegreesButNonZeroEdgeDelta() {
    const dir = await Deno.makeTempDir({ prefix: "episodes_b1b_" });
    const { kernel, db } = await fileKernel(dir);
    try {
      // Two distinct out-edges: a function call and a config read.
      const src = 'return functions.call("x") + config.get("y")';
      registerFn(kernel, "f", src);
      await record(kernel, {
        category: "function",
        key: "f",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: { name: "f", source: src },
        origin: "ai",
      });
      // create edgeDelta = out-edge count (before was ∅).
      assertEquals(readEpisodesRaw(dir)[0]!.features.edgeDelta, 2);

      kernel.functions.remove("f");
      await record(kernel, {
        category: "function",
        key: "f",
        action: "delete",
        beforeSnapshot: { name: "f", source: src },
        afterSnapshot: null,
        origin: "ai",
      });

      const del = readEpisodesRaw(dir).find((e) => e.op === "delete")!;
      // The entity is gone from the after-graph → no current degrees (null, not wrong).
      assertEquals(del.features.inDegree, null);
      assertEquals(del.features.outDegree, null);
      assertEquals(del.features.dependentCount, null);
      // But the removed out-edges are still counted (after = ∅).
      assertEquals(del.features.edgeDelta, 2);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

Deno.test(
  testOpts,
  async function b1bNonGraphCategoryHasNullDegreesButEdgeDelta() {
    const dir = await Deno.makeTempDir({ prefix: "episodes_b1b_" });
    const { kernel, db } = await fileKernel(dir);
    try {
      // A test is uid-bearing (so it emits an episode) but NOT a call-graph node, so
      // the after-graph can't give it degrees — yet edgeDelta is still source-derived.
      const src = 'functions.call("subject")';
      kernel.tests.register("t1", src, () => Promise.resolve());
      await record(kernel, {
        category: "test",
        key: "t1",
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: { name: "t1", source: src },
        origin: "ai",
      });

      const ep = readEpisodesRaw(dir)[0]!;
      assertEquals(ep.category, "test");
      assertEquals(ep.features.inDegree, null);
      assertEquals(ep.features.outDegree, null);
      assertEquals(ep.features.dependentCount, null);
      assertEquals(ep.features.edgeDelta, 1); // still computed from its source
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// --- Stream C / C1: entitySurvivalRate ---

const NOW = Date.parse("2026-07-29T00:00:00.000Z");

// Build a latest-per-uid SurvivalObservation with only the fields the metric reads.
function makeObs(
  entityUid: string,
  o: {
    origin?: "ai" | "human";
    ageDays: number;
    alive?: boolean;
    modified?: boolean;
    depth?: number | null;
    observedAt?: string;
    weight?: number | null;
  },
): SurvivalObservation {
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    observationId: `obs_${entityUid}`,
    entityUid,
    observedAt: o.observedAt ?? "2026-07-29T00:00:00.000Z",
    alive: o.alive ?? true,
    modifiedSinceAuthoring: o.modified ?? false,
    modificationCount: o.modified ? 1 : 0,
    modificationDepth: o.depth ?? null,
    ageDays: o.ageDays,
    authoringOrigin: o.origin ?? "ai",
    weight: o.weight ?? null,
  };
}

Deno.test("C1: cohorts count only entities old enough, and survival = alive AND unmodified", () => {
  const obs = [
    makeObs("ent_1", { ageDays: 200, alive: true, modified: false }), // survives all cohorts
    makeObs("ent_2", { ageDays: 200, alive: false }), // died — in every cohort's n, not a survivor
    makeObs("ent_3", { ageDays: 200, alive: true, modified: true, depth: 0.5 }), // alive but thrashing
    makeObs("ent_4", { ageDays: 100, alive: true, modified: false }), // survives 30 & 90, too young for 180
    makeObs("ent_5", { ageDays: 10, alive: true, modified: false }), // too young for any cohort
  ];
  const m = entitySurvivalRate(obs, NOW);

  const c = (days: number) => m.ai.cohorts.find((x) => x.cohortDays === days)!;
  // 30-day: ent_1..4 are eligible (>=30); ent_5 excluded. Survivors = ent_1, ent_4.
  assertEquals(c(30).n, 4);
  assertEquals(c(30).survivors, 2);
  assertEquals(c(30).rate, 0.5);
  // 90-day: same 4 eligible (all >=90). Survivors still ent_1, ent_4.
  assertEquals(c(90).n, 4);
  assertEquals(c(90).rate, 0.5);
  // 180-day: only ent_1..3 eligible (ent_4 is 100d). Survivor = ent_1 only.
  assertEquals(c(180).n, 3);
  assertEquals(c(180).survivors, 1);
  assertEquals(c(180).rate, 1 / 3);

  // The thrashing set + its modification depth.
  assertEquals(m.ai.aliveButModified, 1);
  assertEquals(m.ai.modificationDepthMedian, 0.5);
  assertEquals(m.ai.totalEntities, 5);
});

Deno.test("C1: AI is the hero line, human is a separate baseline, other origins excluded", () => {
  const obs = [
    makeObs("ai_1", {
      origin: "ai",
      ageDays: 40,
      alive: true,
      modified: false,
    }),
    makeObs("hu_1", {
      origin: "human",
      ageDays: 40,
      alive: true,
      modified: false,
    }),
    makeObs("hu_2", { origin: "human", ageDays: 40, alive: false }),
  ];
  const m = entitySurvivalRate(obs, NOW);
  assertEquals(m.ai.cohorts.find((x) => x.cohortDays === 30)!.rate, 1); // 1/1
  assertEquals(m.human.cohorts.find((x) => x.cohortDays === 30)!.rate, 0.5); // 1/2
  assertEquals(m.ai.totalEntities, 1);
  assertEquals(m.human.totalEntities, 2);
});

Deno.test("C1: leading indicators (alive / pristine / thrashing) are age-agnostic and visible immediately", () => {
  const obs = [
    makeObs("e1", { ageDays: 5, alive: true, modified: false }), // young but pristine
    makeObs("e2", { ageDays: 5, alive: true, modified: true, depth: 0.3 }), // young, thrashing
    makeObs("e3", { ageDays: 5, alive: false }), // died young
  ];
  const m = entitySurvivalRate(obs, NOW);
  // No cohort has matured (all 5 days old)...
  assertEquals(m.ai.cohorts.every((c) => c.n === 0 && c.rate === null), true);
  // ...but the leading indicators are already meaningful.
  assertEquals(m.ai.totalEntities, 3);
  assertEquals(m.ai.aliveCount, 2); // e1, e2
  assertEquals(m.ai.survivorsAllAges, 1); // e1 only (alive AND unmodified)
  assertEquals(m.ai.aliveButModified, 1); // e2
  assertEquals(m.ai.modificationDepthMedian, 0.3);
});

Deno.test("C1: an empty cohort yields a null rate, never NaN or a fabricated percentage", () => {
  const m = entitySurvivalRate([], NOW);
  for (const cohort of m.ai.cohorts) {
    assertEquals(cohort.n, 0);
    assertEquals(cohort.rate, null);
  }
  assertEquals(m.ai.modificationDepthMedian, null);
  assertEquals(m.ai.totalEntities, 0);
});

Deno.test("C1: only the latest observation per entityUid counts", () => {
  const obs = [
    // An early pass saw ent_X alive & unmodified...
    makeObs("ent_X", {
      ageDays: 40,
      alive: true,
      modified: false,
      observedAt: "2026-07-01T00:00:00.000Z",
    }),
    // ...a later pass saw it modified. The latest wins → not a survivor.
    makeObs("ent_X", {
      ageDays: 40,
      alive: true,
      modified: true,
      depth: 0.2,
      observedAt: "2026-07-28T00:00:00.000Z",
    }),
  ];
  const m = entitySurvivalRate(obs, NOW);
  const c30 = m.ai.cohorts.find((x) => x.cohortDays === 30)!;
  assertEquals(c30.n, 1);
  assertEquals(c30.survivors, 0);
  assertEquals(m.ai.aliveButModified, 1);
});

// --- Stream B / B1d: graph-weighted survival ---

Deno.test("B1d: computeSurvivalObservations fills weight = dependentCount + 1; null when no graph", () => {
  const eps: VerificationEpisode[] = [
    makeEp("ent_hub", "create", "ai", 100, null, "2026-07-01T00:00:00.000Z"),
    makeEp("ent_leaf", "create", "ai", 50, null, "2026-07-01T00:00:00.000Z"),
  ];
  const now = Date.parse("2026-07-20T00:00:00.000Z");

  // Graph passed: hub has 4 transitive dependents, leaf has 0, unknown uid → null.
  const dependentCountForUid = (uid: string): number | null =>
    uid === "ent_hub" ? 4 : uid === "ent_leaf" ? 0 : null;
  const withGraph = computeSurvivalObservations(
    eps,
    new Set(),
    now,
    dependentCountForUid,
  );
  const hub = withGraph.find((o) => o.entityUid === "ent_hub")!;
  const leaf = withGraph.find((o) => o.entityUid === "ent_leaf")!;
  assertEquals(hub.weight, 5); // 4 dependents + 1
  assertEquals(leaf.weight, 1); // leaf: 0 + 1

  // A uid the graph can't resolve → 0 dependents → weight 1 (not null, not wrong).
  const orphan = computeSurvivalObservations(
    [makeEp("ent_gone", "delete", "ai", 0, null, "2026-07-01T00:00:00.000Z")],
    new Set(),
    now,
    dependentCountForUid,
  )[0]!;
  assertEquals(orphan.weight, 1);

  // No graph passed at all → weight null on every observation (accrue-forward).
  const weightless = computeSurvivalObservations(eps, new Set(), now);
  assertEquals(weightless.every((o) => o.weight === null), true);
});

Deno.test("B1d acceptance: a surviving keystone outweighs a dying leaf (50% unweighted, ~83% weighted)", () => {
  // Two AI entities: a keystone (weight 5) that survives and a leaf (weight 1) that
  // dies. Unweighted intact rate is a flat 50%; graph weight sharpens it to ~83%
  // because the LOAD-BEARING thing is the one that survived.
  const obs = [
    makeObs("keystone", {
      ageDays: 40,
      alive: true,
      modified: false,
      weight: 5,
    }),
    makeObs("leaf", { ageDays: 40, alive: false, weight: 1 }),
  ];
  const m = entitySurvivalRate(obs, NOW);

  // Unweighted: 1 of 2 survives → 50%.
  assertEquals(m.ai.survivorsAllAges, 1);
  assertEquals(m.ai.totalEntities, 2);
  assertEquals(m.ai.survivorsAllAges / m.ai.totalEntities, 0.5);

  // Weighted: 5 of (5+1) → 5/6 ≈ 0.833.
  assertEquals(m.ai.weightedSurvivalRate, 5 / 6);
  assert(
    m.ai.weightedSurvivalRate! > 0.83 && m.ai.weightedSurvivalRate! < 0.84,
  );
});

Deno.test("B1d: weightedSurvivalRate uses weight ?? 1 (null-weight cohort ≈ unweighted); null when empty", () => {
  // A cohort of null-weight (pre-B1d) observations: weight ?? 1 makes every entity a
  // leaf, so the weighted rate collapses onto the unweighted intact rate. 2 of 3 alive
  // & unmodified → both rates 2/3.
  const obs = [
    makeObs("a", { ageDays: 40, alive: true, modified: false, weight: null }),
    makeObs("b", { ageDays: 40, alive: true, modified: false, weight: null }),
    makeObs("c", { ageDays: 40, alive: false, weight: null }),
  ];
  const m = entitySurvivalRate(obs, NOW);
  assertEquals(m.ai.weightedSurvivalRate, 2 / 3);
  assertEquals(m.ai.survivorsAllAges / m.ai.totalEntities, 2 / 3);

  // No entities of an origin → null (never NaN, never a fabricated rate).
  assertEquals(m.human.weightedSurvivalRate, null);
  assertEquals(entitySurvivalRate([], NOW).ai.weightedSurvivalRate, null);
});

Deno.test(testOpts, async function c2RealLogFeedsTheMetric() {
  // The C2a wiring: the real survival.jsonl the kernel writes must be exactly what
  // entitySurvivalRate consumes. Drive an AI entity, observe at a point 200 days on,
  // and confirm the metric reads it back as an AI survivor across every cohort.
  const dir = await Deno.makeTempDir({ prefix: "episodes_c2_" });
  const { kernel, db } = await fileKernel(dir);
  try {
    registerFn(kernel, "keeper", "abc");
    await record(kernel, {
      category: "function",
      key: "keeper",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "keeper", source: "abc" },
      origin: "ai",
    });
    // Observe 200 days after the create so the entity clears every cohort.
    const authoredAt = kernel.episodeLog!.readEpisodes()[0]!.occurredAt;
    const now = Date.parse(authoredAt) + 200 * 86_400_000;
    kernel.observeSurvival(now);

    const metric = entitySurvivalRate(
      kernel.episodeLog!.readObservations(),
      now,
    );
    assertEquals(metric.ai.totalEntities, 1);
    assertEquals(metric.human.totalEntities, 0);
    for (const cohort of metric.ai.cohorts) {
      assertEquals(cohort.n, 1);
      assertEquals(cohort.survivors, 1);
      assertEquals(cohort.rate, 1);
    }
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Stream B / B1d integration (real file-backed kernel + live graph) ---

Deno.test(testOpts, async function b1dObserveSurvivalIsReadOnly() {
  // The survival pass builds a knowledge graph to weight observations. That graph is a
  // DERIVED, read-only projection — observing must never mutate node/edge counts or
  // the registry (plan §7.2/§7.4).
  const dir = await Deno.makeTempDir({ prefix: "episodes_b1d_" });
  const { kernel, db } = await fileKernel(dir);
  try {
    registerFn(kernel, "callee", "return 1");
    await record(kernel, {
      category: "function",
      key: "callee",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "callee", source: "return 1" },
      origin: "ai",
    });
    registerFn(kernel, "caller", 'return functions.call("callee")');
    await record(kernel, {
      category: "function",
      key: "caller",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: {
        name: "caller",
        source: 'return functions.call("callee")',
      },
      origin: "ai",
    });

    const before = buildKnowledgeGraph(kernel);
    const beforeNodes = before.nodeCount;
    const beforeEdges = before.edgeCount;
    const beforeFns = kernel.functions.list().length;

    kernel.observeSurvival(Date.parse("2026-07-28T00:00:00.000Z"));

    const after = buildKnowledgeGraph(kernel);
    assertEquals(after.nodeCount, beforeNodes);
    assertEquals(after.edgeCount, beforeEdges);
    assertEquals(kernel.functions.list().length, beforeFns);

    // The weight landed: caller depends on callee, so callee outweighs the leaf caller.
    const obs = kernel.episodeLog!.readObservations();
    const calleeUid = kernel.functions.getEntry("callee")!.entityUid;
    const callerUid = kernel.functions.getEntry("caller")!.entityUid;
    const calleeObs = obs.find((o) => o.entityUid === calleeUid)!;
    const callerObs = obs.find((o) => o.entityUid === callerUid)!;
    assertEquals(calleeObs.weight, 2); // 1 dependent (caller) + 1
    assertEquals(callerObs.weight, 1); // a leaf: 0 + 1
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

Deno.test(testOpts, async function streamBExitTestSharedFnWeightedAboveLeaf() {
  // The §5 Stream B exit test, end to end: create a shared function, wire three
  // entities to depend on it, edit it, delete it — proving all four items at once:
  //   B1b  the edit episode carries correct degrees (inDegree/dependentCount 3) + edgeDelta;
  //   B1c  the blast-radius projection reports the three dependents;
  //   B1d  graph-weighted survival weights the shared fn (weight 4) above a leaf (weight 1).
  const dir = await Deno.makeTempDir({ prefix: "episodes_streamb_" });
  const { kernel, db } = await fileKernel(dir);
  try {
    // Shared function (starts edge-free) + a wholly independent leaf.
    const sharedUid = registerFn(kernel, "shared", "return 1");
    await record(kernel, {
      category: "function",
      key: "shared",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "shared", source: "return 1" },
      origin: "ai",
    });
    const leafUid = registerFn(kernel, "leaf", "return 2");
    await record(kernel, {
      category: "function",
      key: "leaf",
      action: "create",
      beforeSnapshot: null,
      afterSnapshot: { name: "leaf", source: "return 2" },
      origin: "ai",
    });

    // Three entities depend on `shared`.
    for (const dep of ["depA", "depB", "depC"]) {
      const src = `return functions.call("shared")`;
      registerFn(kernel, dep, src);
      await record(kernel, {
        category: "function",
        key: dep,
        action: "create",
        beforeSnapshot: null,
        afterSnapshot: { name: dep, source: src },
        origin: "ai",
      });
    }

    // Edit `shared` — adds one out-edge (a config read) → B1b edgeDelta, and the
    // after-graph now shows its three inbound dependents.
    const editedSrc = 'return config.get("flag")';
    registerFn(kernel, "shared", editedSrc);
    await record(kernel, {
      category: "function",
      key: "shared",
      action: "update",
      beforeSnapshot: { name: "shared", source: "return 1" },
      afterSnapshot: { name: "shared", source: editedSrc },
      origin: "ai",
    });

    // B1b: the edit episode of `shared` carries its degrees from the after-graph.
    const editEp = readEpisodesRaw(dir).find((e) =>
      e.entityUid === sharedUid && e.op === "update"
    )!;
    assertEquals(editEp.features.inDegree, 3); // depA/B/C reference it
    assertEquals(editEp.features.dependentCount, 3); // transitive reverse reach
    assert(editEp.features.outDegree! >= 1); // now reads config:flag
    assert(editEp.features.edgeDelta! >= 1); // an out-edge was added

    // B1c: the blast-radius projection (the exact shape the API returns) reports the
    // three dependents, and only those.
    const report = blastRadiusReport(
      buildKnowledgeGraph(kernel),
      "function",
      "shared",
    );
    assertEquals(report.counts.direct, 3);
    assertEquals(
      new Set(report.direct.map((r) => r.name)),
      new Set(["depA", "depB", "depC"]),
    );

    // B1d: observe survival WHILE `shared` is alive → its weight reflects the 3
    // dependents (3 + 1 = 4), well above the independent leaf's weight (1).
    kernel.observeSurvival(Date.parse("2026-07-28T00:00:00.000Z"));
    const obs = kernel.episodeLog!.readObservations();
    const sharedObs = obs.find((o) => o.entityUid === sharedUid)!;
    const leafObs = obs.find((o) => o.entityUid === leafUid)!;
    assertEquals(sharedObs.weight, 4);
    assertEquals(leafObs.weight, 1);
    assert(sharedObs.weight! > leafObs.weight!); // the keystone outweighs the leaf

    // …and delete it — B1b: because depA/B/C still reference `shared` by name, it
    // lingers in the after-graph as a DANGLING node, so its degrees are populated,
    // not null. dependentCount is exactly the deletion's blast radius (the 3 now-
    // orphaned dependents); edgeDelta counts the out-edge (the config read) it lost.
    kernel.functions.remove("shared");
    await record(kernel, {
      category: "function",
      key: "shared",
      action: "delete",
      beforeSnapshot: { name: "shared", source: editedSrc },
      afterSnapshot: null,
      origin: "ai",
    });
    const delEp = readEpisodesRaw(dir).find((e) =>
      e.entityUid === sharedUid && e.op === "delete"
    )!;
    assertEquals(delEp.features.dependentCount, 3); // the 3 orphaned dependents
    assertEquals(delEp.features.edgeDelta, 1); // the config read it lost
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
