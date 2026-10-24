// @layer core — L1. Stream A / A4: the immutable, append-only, **source-free**
// record of every entity-lifecycle change and its verification outcome
// (episodes.jsonl), plus the paired survival-observation log (survival.jsonl).
// This is the payoff slice: it composes A1 (authorOrigin), A2 (entityUid) and A3
// (rename-as-op) into the record from which Entity Survival Rate is computable.
// See docs/stream-a-data-foundation-plan.md §3.3, §3.4, §4 A4, §7.
//
// DELIBERATE NO-DB-STORE CHOICE (sharpening S3, plan §2): unlike the changelog and
// changesets, the episode log has **no** DB-backed store and does not follow the
// File+DB parity convention. The shipped runtime is file-backed (project-loader
// always passes a historyDir), so a DB-only store would not even run by default,
// and an append-only log is the one case where parity buys nothing. We pin to
// `appendJsonLine` here; the read side is a plain JSONL scan (`readJsonLines`),
// which is more than sufficient at these volumes. Revisit only if C2's survival
// queries ever outgrow a scan (they won't). This is modelled on the O(1)-append
// history-store primitives, NOT on the verification ledger (which rewrites the
// whole array per append — O(n²)).
//
// STANDING RULE (plan §7): nothing written here may contain source, diffs, free
// text, or paths. Every feature is a NUMBER derived locally (e.g. `changedBytes`,
// never the diff). `context.userMessage` (free text) and A3's `context.renamedFrom`
// (a local-only entity name) are deliberately NOT threaded into any episode. This
// is a property of the SCHEMA below (only numbers, enums and correlation ids are
// representable), not a policy bolted on top. Episodes are also IMMUTABLE: an
// outcome accrues only as a separate SurvivalObservation, never by mutating an
// episode. Keeping the schema this clean makes the future C3 export projection a
// pure field-drop + entityName hash, not a rewrite (plan §6).

import { join } from "node:path";
import type { ChangeCategory, ChangeRecord } from "../shared/changelog.ts";
import type {
  AttestationKind,
  Changeset,
  ChangesetStatus,
  VerificationStatus,
} from "../shared/verification.ts";
import {
  appendJsonLine,
  readJsonLines,
  rewriteJsonLines,
} from "./history-store.ts";
import { createTimestampedId } from "./ids.ts";
import { extractOutEdges } from "./analysis.ts";
import type {
  SurvivalByOrigin,
  SurvivalCohort,
  SurvivalMetric,
} from "../shared/metrics.ts";

export type { SurvivalByOrigin, SurvivalCohort, SurvivalMetric };

export const EPISODE_SCHEMA_VERSION = 1 as const;

// The structural operations survival cares about. A change record's ChangeAction
// is a superset ("execute"/"restore" also exist); mapActionToOp filters to these.
export type EpisodeOp = "create" | "update" | "delete" | "rename";

export type EpisodeAuthorOrigin = "ai" | "human";
export type EpisodeHumanDecision = "accepted" | "rejected" | "pending" | null;

// Structural features — numbers only, all locally derived. Graph fields stay null
// until B1 wires the knowledge graph, then accrue forward only (no backfill).
export interface EpisodeFeatures {
  sourceBytes: number;
  sourceLines: number;
  prevSourceBytes: number | null; // null on create (no prior source)
  changedBytes: number | null; // magnitude of the size delta, NEVER its content
  inDegree: number | null;
  outDegree: number | null;
  dependentCount: number | null;
  edgeDelta: number | null;
}

// Verification outcome at this change — counts and enums only, never diagnostic
// text. Populated from the attestations/gate outcomes attached to the active
// changeset AT CHANGE TIME (§4 A4.4).
export interface EpisodeVerification {
  ran: boolean;
  outcome: "passed" | "failed" | "partial" | "none";
  testsPassed: number | null;
  testsFailed: number | null;
  typecheckOk: boolean | null;
  lintErrors: number | null; // null until D3 persists lint outcomes
  auditIssues: number | null;
  coveragePercent: number | null;
  attestationKinds: AttestationKind[]; // kinds only, no detail
}

export interface VerificationEpisode {
  schemaVersion: typeof EPISODE_SCHEMA_VERSION;
  episodeId: string; // createTimestampedId("epi")
  entityUid: string; // A2 — the survival key
  category: ChangeCategory;
  op: EpisodeOp;
  authorOrigin: EpisodeAuthorOrigin;
  occurredAt: string; // ISO 8601 (the change record's createdAt)

  // Correlation ids only — NO content
  turnId: string | null;
  changesetId: string | null;
  sessionId: string | null;
  stepId: string | null; // null until D1 populates it

  features: EpisodeFeatures;
  verification: EpisodeVerification;
  humanDecision: EpisodeHumanDecision;
}

// A survival observation is appended (never mutated onto an episode) so an
// entity's longitudinal outcome accrues over time. C2's Entity Survival Rate reads
// the latest observation per entityUid.
export interface SurvivalObservation {
  schemaVersion: typeof EPISODE_SCHEMA_VERSION;
  observationId: string; // createTimestampedId("obs")
  entityUid: string;
  observedAt: string; // ISO 8601
  alive: boolean; // entity still present in the registry
  modifiedSinceAuthoring: boolean;
  modificationCount: number; // change episodes since the authoring episode
  modificationDepth: number | null; // cumulative changedBytes / original sourceBytes
  ageDays: number; // since the authoring episode
  authoringOrigin: EpisodeAuthorOrigin; // origin of the authoring episode (the metric filter)
  // Stream B / B1d (sharpening S5): the entity's graph weight AT OBSERVE TIME =
  // its current dependentCount + 1 (a leaf still counts as 1, a keystone more).
  // Read from the LIVE knowledge graph, not the authoring episode's degrees —
  // importance accretes after creation. A number, so it is allowed on-disk (the
  // numbers-only rule forbids source/names/paths, not degrees). null when no graph
  // was supplied to the pass (accrue-forward — old observations stay weightless,
  // never backfilled). A dead entity's uid isn't in the current graph → weight 1
  // (correctly, it has no current dependents), still observed with alive=false.
  weight: number | null;
}

// --- The append-only log ---

export class EpisodeLog {
  constructor(private readonly historyDir: string) {}

  private episodesPath(): string {
    return join(this.historyDir, "episodes.jsonl");
  }

  private survivalPath(): string {
    return join(this.historyDir, "survival.jsonl");
  }

  // O(1) append — the whole point of S3. Never rewrites the file.
  record(episode: VerificationEpisode): void {
    appendJsonLine(this.episodesPath(), episode);
  }

  observe(observation: SurvivalObservation): void {
    appendJsonLine(this.survivalPath(), observation);
  }

  readEpisodes(): VerificationEpisode[] {
    return readJsonLines<VerificationEpisode>(this.episodesPath());
  }

  readObservations(): SurvivalObservation[] {
    return readJsonLines<SurvivalObservation>(this.survivalPath());
  }

  // Retention cap mirroring verificationLedgerRetention (keep the newest `keep`,
  // drop the oldest). 0/negative ⇒ keep-all (the default), a pure no-op. Only ever
  // called at boot, so the one-time O(n) rewrite is fine; the hot append path stays
  // O(1). Trimming the oldest lines is a retention policy, not a mutation of a
  // retained episode — retained episodes are still never rewritten in content.
  prune(keep: number): void {
    if (keep <= 0) return;
    const episodes = this.readEpisodes();
    if (episodes.length > keep) {
      rewriteJsonLines(
        this.episodesPath(),
        episodes.slice(episodes.length - keep),
      );
    }
    const observations = this.readObservations();
    if (observations.length > keep) {
      rewriteJsonLines(
        this.survivalPath(),
        observations.slice(observations.length - keep),
      );
    }
  }
}

// --- Pure composition helpers (no kernel, no I/O — trivially testable) ---

// Map a change action to the survival op, or null to SKIP emitting an episode.
// - create/update/delete/rename map directly (the structural authoring ops).
// - "execute" is a RUN, not a structural change — skip (it would pollute the log
//   with non-authoring events and has no source delta).
// - "restore" is a reversal (snapshot restore / the record an undo-redo replays),
//   NOT authoring. Emitting it would DOUBLE-COUNT survival (a restore of a prior
//   version reads as a fresh modification), so we skip it. Tradeoff: a
//   restore-to-older-source is invisible to the episode log; the survival pass
//   still sees the entity as alive via the live registry, which is the property
//   the metric actually needs. Undo/redo never write new records (they move a
//   cursor), so there is nothing extra to skip there.
export function mapActionToOp(
  action: ChangeRecord["action"],
): EpisodeOp | null {
  switch (action) {
    case "create":
    case "update":
    case "delete":
    case "rename":
      return action;
    case "execute":
    case "restore":
      return null;
    default:
      return null;
  }
}

// Extract a source-bearing string from a change snapshot for SIZE measurement
// only. The returned string never leaves this module — only byte/line counts
// derived from it are stored — so a structural JSON fallback for shapes without a
// plain source field (types, config values) is safe: it yields a stable number,
// not leaked content.
function sourceStringOf(snapshot: unknown): string | null {
  if (snapshot === null || typeof snapshot !== "object") return null;
  const record = snapshot as Record<string, unknown>;
  for (const field of ["source", "content", "contentBase64", "sql"]) {
    const value = record[field];
    if (typeof value === "string") return value;
  }
  if (typeof record.value === "string") return record.value;
  if (record.value !== undefined) return JSON.stringify(record.value);
  if (record.fields !== undefined) return JSON.stringify(record.fields);
  return JSON.stringify(record);
}

const encoder = new TextEncoder();

function measure(snapshot: unknown): { bytes: number; lines: number } | null {
  const source = sourceStringOf(snapshot);
  if (source === null) return null;
  return {
    bytes: encoder.encode(source).length,
    lines: source.length === 0 ? 0 : source.split("\n").length,
  };
}

// B1b: the changed entity's own out-edge CHURN — the count of outgoing dependencies
// it added or removed — as the symmetric difference of its out-edge fingerprint
// before vs after. Purely local (two source strings, no whole-graph reconstruction):
// create (before = ∅) ⇒ the new entity's out-edge count; delete (after = ∅) ⇒ the
// removed-edge count; a no-op edit ⇒ 0. Only the SIZE (a number) is kept — the target
// names in the sets never leave this function. In-edge / whole-project effects accrue
// over time as the OTHER entities' changes emit their own episodes (accrue-forward),
// so no before-graph is reconstructed here. Computable for any source-bearing entity,
// even non-graph-node categories (e.g. tests), which is why it lives in the pure,
// source-only featuresFor rather than behind the graph-node-only degree fields.
function edgeDeltaFor(record: ChangeRecord): number {
  const before = extractOutEdges(sourceStringOf(record.beforeSnapshot) ?? "");
  const after = extractOutEdges(sourceStringOf(record.afterSnapshot) ?? "");
  let delta = 0;
  for (const id of before) if (!after.has(id)) delta++;
  for (const id of after) if (!before.has(id)) delta++;
  return delta;
}

// Features derived purely from the change's before/after snapshots. `changedBytes`
// is a size delta (|after − before|), NEVER the diff itself. On create the prior
// size is treated as 0 (whole entity is new); on delete the resulting size is 0.
// The three degree fields stay null here (graph-node-only, filled by buildEpisode
// when a knowledge graph is supplied); `edgeDelta` is source-derivable, so it is
// computed here and holds for any source-bearing entity.
export function featuresFor(record: ChangeRecord): EpisodeFeatures {
  const after = measure(record.afterSnapshot);
  const before = measure(record.beforeSnapshot);
  const sourceBytes = after?.bytes ?? 0;
  const sourceLines = after?.lines ?? 0;
  const prevSourceBytes = before ? before.bytes : null;
  const changedBytes = Math.abs(sourceBytes - (prevSourceBytes ?? 0));
  return {
    sourceBytes,
    sourceLines,
    prevSourceBytes,
    changedBytes,
    inDegree: null,
    outDegree: null,
    dependentCount: null,
    edgeDelta: edgeDeltaFor(record),
  };
}

const NO_VERIFICATION: EpisodeVerification = {
  ran: false,
  outcome: "none",
  testsPassed: null,
  testsFailed: null,
  typecheckOk: null,
  lintErrors: null,
  auditIssues: null,
  coveragePercent: null,
  attestationKinds: [],
};

function countByStatus(
  atts: { kind: AttestationKind; status: VerificationStatus }[],
  kind: AttestationKind,
  status: VerificationStatus,
): number {
  return atts.filter((a) => a.kind === kind && a.status === status).length;
}

// Summarize the verification state attached to a changeset into counts + enums
// only (plan §4 A4.4). Never reads diagnostic text. A null changeset (change made
// outside any changeset flow, or the changeset store is absent) ⇒ "none".
export function summarizeVerification(
  changeset: Changeset | null,
): EpisodeVerification {
  if (!changeset) return { ...NO_VERIFICATION };
  const atts = changeset.plan.attestations ?? [];
  const runs = changeset.plan.verificationRuns ?? [];
  const ran = atts.length > 0 || runs.length > 0;

  const attestationKinds = [...new Set(atts.map((a) => a.kind))].sort();
  const testAtts = atts.filter((a) => a.kind === "test");
  const typecheckAtts = atts.filter((a) => a.kind === "typecheck");
  const auditAtts = atts.filter((a) => a.kind === "audit");

  let outcome: EpisodeVerification["outcome"];
  if (runs.length > 0) {
    const latest = runs.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
    outcome = latest.status === "manual" ? "partial" : latest.status;
  } else if (atts.length > 0) {
    if (atts.every((a) => a.status === "passed")) outcome = "passed";
    else if (atts.some((a) => a.status === "failed")) outcome = "failed";
    else outcome = "partial";
  } else {
    outcome = "none";
  }

  return {
    ran,
    outcome,
    testsPassed: testAtts.length ? countByStatus(atts, "test", "passed") : null,
    testsFailed: testAtts.length ? countByStatus(atts, "test", "failed") : null,
    typecheckOk: typecheckAtts.length
      ? typecheckAtts.every((a) => a.status === "passed")
      : null,
    lintErrors: null, // reserved until D3
    auditIssues: auditAtts.length
      ? countByStatus(atts, "audit", "failed")
      : null,
    coveragePercent: null, // attestations carry no numeric coverage today
    attestationKinds,
  };
}

// Human decision derived from the enclosing changeset's status. Not a decision
// SIGNAL by itself — most changes are captured while the changeset is still
// in-flight ("pending"); the durable accept/reject shows up on later episodes /
// observations of the same entity once the changeset resolves.
export function statusToHumanDecision(
  status: ChangesetStatus | null,
): EpisodeHumanDecision {
  switch (status) {
    case "rejected":
    case "abandoned":
      return "rejected";
    case "approved":
    case "completed":
      return "accepted";
    case "planning":
    case "in_progress":
      return "pending";
    default:
      return null;
  }
}

// Build an immutable episode from a change record plus the already-resolved
// verification/human-decision context. The caller (Kernel.emitEpisode) guarantees
// the record carries a known entityUid and authorOrigin — the two invariants the
// non-nullable schema fields encode.
export function buildEpisode(input: {
  record: ChangeRecord;
  op: EpisodeOp;
  authorOrigin: EpisodeAuthorOrigin;
  entityUid: string;
  verification: EpisodeVerification;
  humanDecision: EpisodeHumanDecision;
  // B1b: the changed entity's degrees from the AFTER knowledge graph, merged over
  // featuresFor's nulls. Numbers only. null (or omitted) when the graph couldn't
  // resolve the entity — a non-graph-node category, or a delete whose entity is gone
  // from the after-graph — leaving the degrees null ("not computed"), never wrong.
  graph?:
    | { inDegree: number; outDegree: number; dependentCount: number }
    | null;
}): VerificationEpisode {
  const { record } = input;
  const features = featuresFor(record);
  if (input.graph) {
    features.inDegree = input.graph.inDegree;
    features.outDegree = input.graph.outDegree;
    features.dependentCount = input.graph.dependentCount;
  }
  return {
    schemaVersion: EPISODE_SCHEMA_VERSION,
    episodeId: createTimestampedId("epi"),
    entityUid: input.entityUid,
    category: record.category,
    op: input.op,
    authorOrigin: input.authorOrigin,
    occurredAt: record.createdAt,
    turnId: record.turnId,
    changesetId: record.changesetId,
    sessionId: record.context?.sessionId ?? null,
    stepId: null,
    features,
    verification: input.verification,
    humanDecision: input.humanDecision,
  };
}

// Compute one survival observation per entity that has any episode. Driven by the
// immutable episode log grouped by entityUid, cross-referenced with the set of
// currently-live uids for `alive` (so a deleted entity still yields an observation
// with alive=false — its lifecycle is reported, not dropped). The authoring
// episode is the earliest for the uid; a stable sort on the append-ordered log
// keeps the create ahead of same-millisecond updates.
export function computeSurvivalObservations(
  episodes: VerificationEpisode[],
  liveUids: Set<string>,
  now: number,
  // B1d (S5): the entity's CURRENT transitive dependent count, from a live graph the
  // caller (observeSurvival) builds once and passes in. Pure/testable: this module
  // never touches the kernel or graph directly. A uid the graph can't resolve (dead
  // or non-graph-node entity) returns null → treated as 0 dependents → weight 1.
  // OMITTED entirely ⇒ weight stays null on every observation (accrue-forward: a pass
  // with no graph produces weightless observations, never wrong ones).
  dependentCountForUid?: (entityUid: string) => number | null,
): SurvivalObservation[] {
  const byUid = new Map<string, VerificationEpisode[]>();
  for (const episode of episodes) {
    const existing = byUid.get(episode.entityUid);
    if (existing) existing.push(episode);
    else byUid.set(episode.entityUid, [episode]);
  }

  const observations: SurvivalObservation[] = [];
  for (const [entityUid, eps] of byUid) {
    const ordered = eps
      .map((e, i) => ({ e, i }))
      .sort((a, b) =>
        a.e.occurredAt === b.e.occurredAt
          ? a.i - b.i
          : a.e.occurredAt.localeCompare(b.e.occurredAt)
      )
      .map(({ e }) => e);

    const authoring = ordered[0]!;
    const mods = ordered.slice(1);
    const modificationCount = mods.length;
    const originalBytes = authoring.features.sourceBytes;
    const cumulativeChanged = mods.reduce(
      (sum, e) => sum + (e.features.changedBytes ?? 0),
      0,
    );
    const modificationDepth = originalBytes > 0
      ? cumulativeChanged / originalBytes
      : null;
    const ageDays = (now - Date.parse(authoring.occurredAt)) / 86_400_000;

    // S5: weight = current dependentCount + 1 (leaf = 1, keystone more). No graph
    // passed ⇒ null (accrue-forward). Graph passed but uid unresolved ⇒ 0 + 1 = 1.
    const weight = dependentCountForUid
      ? (dependentCountForUid(entityUid) ?? 0) + 1
      : null;

    observations.push({
      schemaVersion: EPISODE_SCHEMA_VERSION,
      observationId: createTimestampedId("obs"),
      entityUid,
      observedAt: new Date(now).toISOString(),
      alive: liveUids.has(entityUid),
      modifiedSinceAuthoring: modificationCount > 0,
      modificationCount,
      modificationDepth,
      ageDays,
      authoringOrigin: authoring.authorOrigin,
      weight,
    });
  }
  return observations;
}

// --- Stream C / C1: Entity Survival Rate (the metric this substrate exists to make
// visible). Pure over SurvivalObservation[] — no kernel, no I/O — so the endpoint,
// the export, and future consumers all share one computation. See
// docs/stream-c-survival-metric-plan.md §3 C1. Numbers only; no source/name/path.

// The right-censored cohorts (days). "Survival at D" is judged only over entities old
// enough to have reached D (ageDays >= D); each cohort always reports its own `n` so a
// small, provisional sample is never dressed up as a bare percentage.
export const SURVIVAL_COHORT_DAYS = [30, 90, 180] as const;

// Nearest-rank quantile over an ascending-sorted array; null on empty (no fabricated
// central tendency for zero data).
function quantile(sortedAsc: number[], q: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(q * sortedAsc.length));
  return sortedAsc[idx]!;
}

function summarizeOrigin(obs: SurvivalObservation[]): SurvivalByOrigin {
  const cohorts: SurvivalCohort[] = SURVIVAL_COHORT_DAYS.map((cohortDays) => {
    const eligible = obs.filter((o) => o.ageDays >= cohortDays);
    const survivors = eligible.filter((o) =>
      o.alive && !o.modifiedSinceAuthoring
    ).length;
    return {
      cohortDays,
      n: eligible.length,
      survivors,
      rate: eligible.length > 0 ? survivors / eligible.length : null,
    };
  });
  const thrashing = obs.filter((o) => o.alive && o.modifiedSinceAuthoring);
  const depths = thrashing
    .map((o) => o.modificationDepth)
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b);
  // B1d: the weighted analog of the leading intact rate. weight ?? 1 degrades a
  // null-weight (pre-B1d) observation to leaf-equivalent, so this ≈ the unweighted
  // survivorsAllAges rate until real weights accrue, then diverges to favour keystone
  // survival. Weights are >= 1, so totalWeight > 0 whenever obs is non-empty (never a
  // divide-by-zero); null only when the origin has no entities at all.
  const weightOf = (o: SurvivalObservation) => o.weight ?? 1;
  const totalWeight = obs.reduce((sum, o) => sum + weightOf(o), 0);
  const survivorWeight = obs
    .filter((o) => o.alive && !o.modifiedSinceAuthoring)
    .reduce((sum, o) => sum + weightOf(o), 0);
  return {
    totalEntities: obs.length,
    // Leading indicators (any age) — visible on day one, before cohorts mature.
    aliveCount: obs.filter((o) => o.alive).length,
    survivorsAllAges:
      obs.filter((o) => o.alive && !o.modifiedSinceAuthoring).length,
    aliveButModified: thrashing.length,
    modificationDepthMedian: quantile(depths, 0.5),
    modificationDepthP90: quantile(depths, 0.9),
    weightedSurvivalRate: obs.length > 0 ? survivorWeight / totalWeight : null,
    cohorts,
  };
}

export function entitySurvivalRate(
  observations: SurvivalObservation[],
  now: number,
): SurvivalMetric {
  // Collapse to the latest observation per entityUid (observations accrue one-per-pass;
  // older ones are history, not extra data points). Last write wins on an observedAt tie.
  const latest = new Map<string, SurvivalObservation>();
  for (const obs of observations) {
    const prev = latest.get(obs.entityUid);
    if (!prev || obs.observedAt >= prev.observedAt) {
      latest.set(obs.entityUid, obs);
    }
  }
  const all = [...latest.values()];
  return {
    computedAt: new Date(now).toISOString(),
    // authoringOrigin is only ever "ai" | "human"; anything else is excluded (never a
    // data point) simply by not matching either filter.
    ai: summarizeOrigin(all.filter((o) => o.authoringOrigin === "ai")),
    human: summarizeOrigin(all.filter((o) => o.authoringOrigin === "human")),
  };
}
