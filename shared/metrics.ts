// @layer shared — L0, the OpenTide *open* wire contract. TYPE-ONLY (no runtime
// code) and import-free; imports NOTHING (nothing sits below L0). Consumed by the
// Deno backend (core/episodes.ts computes it, control-server serves it) and the IDE
// (`$shared` alias, the Signal card).
//
// Stream C: the Entity Survival Rate metric surface. Numbers only — derived from the
// source-free SurvivalObservation log (Stream A / A4), so nothing here is source, a
// name, a path, or free text. See docs/stream-c-survival-metric-plan.md.

// One right-censored survival cohort. Survival at D days is judged only over entities
// old enough to have reached D; `n` is always reported so a small, provisional sample
// is never dressed up as a bare percentage.
export interface SurvivalCohort {
  cohortDays: number; // 30 | 90 | 180
  n: number; // entities old enough to judge (ageDays >= cohortDays)
  survivors: number; // alive AND unmodified since authoring
  rate: number | null; // survivors / n, or null when n === 0 (never NaN, never faked)
}

export interface SurvivalByOrigin {
  totalEntities: number; // distinct entities of this origin, any age
  // --- Leading indicators, available immediately (any age) — these light up on day
  // one, before any cohort has matured to 30 days. ---
  aliveCount: number; // still present in the registry
  survivorsAllAges: number; // alive AND unmodified so far (the "pristine" count)
  aliveButModified: number; // the "alive but thrashing" set
  modificationDepthMedian: number | null; // over the thrashing set; null when empty
  modificationDepthP90: number | null;
  // Stream B / B1d: the graph-weighted analog of the leading intact rate — Σ weight of
  // survivorsAllAges / Σ weight of all entities of this origin, where weight is the
  // entity's current dependentCount + 1 (a surviving keystone counts for more than a
  // surviving leaf). Uses weight ?? 1, so pre-B1d (null-weight) observations degrade to
  // leaf-equivalent and this ≈ the unweighted intact rate until weighted history
  // accrues. null when this origin has no entities. This is what makes entity-level
  // survival a sharper signal than flat, line-level survival.
  weightedSurvivalRate: number | null;
  // --- The maturing survival cohorts; each fills in as entities age past its window.
  cohorts: SurvivalCohort[];
}

export interface SurvivalMetric {
  computedAt: string; // ISO 8601
  ai: SurvivalByOrigin; // the hero metric (AI-authored survival)
  human: SurvivalByOrigin; // the control/baseline line
}
