// @layer core — Feature G (G4): auto-refresh the model catalog + per-role
// recommendations on project load. Model config is a core concern (every stack
// that loads a project resolves role → model through config.ts), so this hook is
// wired into every composition, not just the agent-bearing one.
//
// Shape: a throttled, non-blocking, structured-logged ProjectInitHook. The hook
// returns immediately — the throttle check is inline and the refresh itself runs
// detached (fire-and-forget) so a slow/failing Models API call never delays or
// crashes startup. All failures funnel through kernel.log.log("warn"/"error",
// "system", …); nothing here throws out of the hook or uses console.
import type { Kernel } from "./registries.ts";
import {
  getAvailableModels,
  getRecommendedModels,
  hasAnyProviderKey,
  isModelCacheStale,
  MODEL_ROLES,
  MODEL_UNCONFIGURED_LABEL,
  MODELS_REFRESH_TTL_MS,
  refreshAvailableModels,
  setRecommendedModels,
} from "./config.ts";
import { recommendModelsFromCatalog } from "./model-recommend.ts";
import { errorMessage } from "./util.ts";

// Project-load lifecycle hook (carried by the composition root's initHooks).
// Returns fast: if the catalog is fresh within the TTL, it logs a skip and
// returns without spawning any work. Otherwise it kicks the refresh off detached
// and returns — runProjectInitHooks never waits on the network.
export function refreshModelsOnStart(kernel: Kernel): Promise<void> {
  if (!isModelCacheStale(MODELS_REFRESH_TTL_MS)) {
    kernel.log.log(
      "debug",
      "system",
      "Model auto-refresh skipped: catalog fresh within TTL",
    );
    return Promise.resolve();
  }

  // Fire-and-forget: the refresh sequence runs unawaited so startup proceeds
  // immediately. Any failure is caught here and logged — it never rethrows.
  void runModelRefresh(kernel).catch((err) => {
    kernel.log.log(
      "warn",
      "system",
      `Model auto-refresh failed: ${errorMessage(err)}`,
    );
  });
  return Promise.resolve();
}

// The detached refresh sequence: freshen the catalog (network only with a key),
// then re-run the deterministic recommend and persist it. Exported for the test —
// callers in production go through refreshModelsOnStart's throttle + detachment.
export async function runModelRefresh(kernel: Kernel): Promise<void> {
  const hasKey = hasAnyProviderKey();

  // Catalog step. refreshAvailableModels() already no-ops without a key, so this
  // is naturally cheap when keyless. We still run the deterministic recommend
  // below either way (it needs no key and stays correct off the built-in
  // catalog), so recommendedModels tracks the latest known models even offline —
  // we just don't hit the network to discover new ones without a key.
  if (hasKey) {
    await refreshAvailableModels();
  }

  // E2 price-refresh seam — deliberately still a no-op (decision, Feature E2 §4).
  // The E2 drift check parses the published docs table, and a docs scrape is
  // format-fragile: wiring it into every project load would let a docs-format
  // change slow or destabilize startup, and E2 never writes PRICING anyway (the
  // fix is a human edit). So price refresh runs OUT OF BAND — `deno task
  // pricing:check` (a weekly cron or manual run), not here. The deterministic
  // recommend already tolerates absent prices (they're only a same-version
  // tiebreak), so nothing here depends on it. Do NOT add price ranking here.
  // See core/pricing-refresh.ts and scripts/refresh-pricing.ts.

  // Re-run the deterministic engine over the (possibly refreshed) catalog and
  // persist via setRecommendedModels — which by construction writes only the
  // recommendedModels map, flowing to every "default" role and never touching an
  // explicit pin (the G5 guarantee is structural, not re-implemented here).
  const before = getRecommendedModels();
  const recommended = recommendModelsFromCatalog(getAvailableModels());
  setRecommendedModels(recommended);

  // Both maps are partial (D9): a role can be absent on either side. `undefined !==
  // undefined` is false, so a role absent on both counts as unchanged; a role that
  // gained or lost a recommendation renders MODEL_UNCONFIGURED_LABEL for its absent
  // side rather than printing "undefined".
  const changed = MODEL_ROLES.filter((role) =>
    before[role] !== recommended[role]
  );
  kernel.log.log(
    "info",
    "system",
    changed.length > 0
      ? `Model auto-refresh: recommendations updated (${
        changed.map((role) =>
          `${role}→${recommended[role] ?? MODEL_UNCONFIGURED_LABEL}`
        ).join(", ")
      })`
      : "Model auto-refresh: recommendations unchanged",
    { metadata: { recommended, hadApiKey: hasKey } },
  );

  // §4 reload semantics: an init hook holds the Kernel, not the control server's
  // per-session chat runtime, so reaching chat.reloadModel() from here would
  // contort the layering. A running chat instead picks up a changed "default"
  // agent model on its next turn / explicit model reload (the PUT endpoint owns
  // the live reloadModel() + system_message path). Documented, deliberately not
  // wired from the hook.
}
