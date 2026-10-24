// @layer core — the deterministic recommend engine (Feature G, G3). Pure catalog
// logic: given the live model catalog it picks the best model per role. This is the
// OPEN, always-available backbone the recommend endpoint runs; any agent-assisted
// refinement (G3 optional) belongs in the closed brain (agent/), never here.
import { MODEL_ROLES, type ModelOption, type ModelRole } from "./config.ts";

// The model family each role's recommendation targets (Feature G Roles list):
// agent authors chat/code (Opus), planning writes plans (Opus), import maps
// source-backed codebases (Sonnet), utility does latency-cheap work (Haiku), and
// verification runs the confidence layer (Sonnet). Family strings match the
// `family` tags getAvailableModels() stamps (see MODELS / modelFamily in config.ts).
const ROLE_TARGET_FAMILY: Record<ModelRole, string> = {
  agent: "claude-opus",
  planning: "claude-opus",
  import: "claude-sonnet",
  utility: "claude-haiku",
  verification: "claude-sonnet",
};

// A comparable "version score" for a model id within its family: the numeric
// tokens after the family prefix, in order. "claude-opus-5" → [5],
// "claude-opus-4-8" → [4, 8], "claude-haiku-4-5-20251001" → [4, 5, 20251001].
// Higher (compared element-by-element) means newer/more capable.
function versionScore(id: string, family: string): number[] {
  const rest = id.startsWith(family) ? id.slice(family.length) : id;
  return (rest.match(/\d+/g) ?? []).map(Number);
}

// Element-wise numeric comparison; a missing element counts as 0. Positive when
// `a` is newer than `b`.
function compareVersion(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// The best model in a family: newest by version score, with output price as a
// tiebreak ONLY when both candidates carry pricing (no price data exists today —
// the Models API fetch sets id/label/family only — so this stays a pure tiebreak).
function pickBestInFamily(
  candidates: ModelOption[],
  family: string,
): string | undefined {
  let best: ModelOption | undefined;
  for (const candidate of candidates) {
    if (!best) {
      best = candidate;
      continue;
    }
    const cmp = compareVersion(
      versionScore(candidate.id, family),
      versionScore(best.id, family),
    );
    if (cmp > 0) {
      best = candidate;
    } else if (cmp === 0) {
      const candidatePrice = candidate.pricing?.output;
      const bestPrice = best.pricing?.output;
      if (
        typeof candidatePrice === "number" &&
        typeof bestPrice === "number" &&
        candidatePrice < bestPrice
      ) {
        best = candidate;
      }
    }
  }
  return best?.id;
}

// The deterministic recommend engine: given the live catalog, return the best
// model id per role. For each role, prefer the newest live model in the role's
// target family; a role whose target family has no catalog match is simply ABSENT
// from the result (D9 — total-but-partial), never seed-filled. Every returned id is
// validated against the catalog — a pick that somehow isn't a real catalog id is
// dropped rather than persisted — so the result is always safe to hand to
// setRecommendedModels(). Pure: no I/O, no LLM, no config writes.
export function recommendModelsFromCatalog(
  available: ModelOption[],
): Partial<Record<ModelRole, string>> {
  const catalogIds = new Set(available.map((m) => m.id));
  const result: Partial<Record<ModelRole, string>> = {};
  for (const role of MODEL_ROLES) {
    const family = ROLE_TARGET_FAMILY[role];
    const candidates = available.filter((m) => m.family === family);
    const pick = pickBestInFamily(candidates, family);
    if (pick && catalogIds.has(pick)) result[role] = pick;
  }
  return result;
}
