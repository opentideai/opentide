// @layer core — project lifecycle hooks (OpenTide §3.3). Upper layers supply
// work to run when a project loads (e.g. verification seeds its ledger) via the
// Kernel's composition context (composition.ts), without project-loader
// importing them. Best-effort: a throwing hook is logged and never blocks load.
import type { Kernel } from "./registries.ts";
import { errorMessage } from "./util.ts";

export type ProjectInitHook = (kernel: Kernel) => Promise<void>;

export async function runProjectInitHooks(kernel: Kernel): Promise<void> {
  for (const hook of kernel.composition.initHooks) {
    try {
      await hook(kernel);
    } catch (err) {
      console.warn(`  Project init hook failed: ${errorMessage(err)}`);
    }
  }
}
