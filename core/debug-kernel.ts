// The kernel a debug session's preview runs on. It holds what the live kernel
// serves (handlers, functions, routes, configs, templates, assets, packages,
// table definitions and the resolved env) over a copy of its database, and runs
// that user code in a runner under the inspector. It lives in the kernel's
// process: only the user code is in the child, under the runner's flags.
//
// Nothing persists: it has no project dir, so no registry writes a file.

import type { Database } from "./db.ts";
import { restoreKernelState, serializeKernelState } from "./persistence.ts";
import { Kernel } from "./registries.ts";
import {
  isRunnerRuntimeAdapter,
  type RunnerBridge,
  type RunnerStart,
} from "./runner/runner-adapter.ts";
import type { Result } from "./types.ts";

export interface DebugKernel {
  kernel: Kernel;
  bridge: RunnerBridge;
  // Entries that didn't make it across, one line each.
  errors: string[];
}

export async function createDebugKernel(
  live: Kernel,
  db: Database,
  runner: RunnerStart,
  appPort: number,
): Promise<Result<DebugKernel>> {
  const kernel = new Kernel(db, {
    userCodeRunner: runner,
    userCodeRunnerOptions: { heartbeat: false },
  });
  if (!isRunnerRuntimeAdapter(kernel.runtime)) {
    return {
      ok: false,
      error: {
        code: "DEBUG_RUNTIME_UNSUPPORTED",
        message: "Only TypeScript user code can be debugged.",
      },
    };
  }
  kernel.appPort = appPort;
  for (const d of live.db.schemas.listDefinitions()) {
    db.schemas.register(d.tableName, [...d.columns]);
  }
  // Secrets, env vars and .env, resolved: the copy has none of the stores.
  for (const [name, value] of Object.entries(live.envSnapshot())) {
    kernel.env.set(name, value);
  }
  const errors = await kernel.packages.restore(live.packages.serialize());
  const state = serializeKernelState(live);
  const restored = await restoreKernelState(kernel, {
    ...state,
    envVars: [],
    packages: [],
    devViews: [],
    devTools: [],
    tests: [],
    customAudits: [],
    branches: [],
  }, () => {});
  return {
    ok: true,
    data: {
      kernel,
      bridge: kernel.runtime.bridge,
      errors: [...errors, ...restored.errors],
    },
  };
}
