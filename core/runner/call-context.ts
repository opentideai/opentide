// The call the runner is running: the trace it records into and, for a dev
// view, the kernel snapshot its `kernel` reads. Held per async context, so
// concurrent calls don't see each other's.

import { AsyncLocalStorage } from "node:async_hooks";
import { runInTrace, type TraceContext } from "../trace-context.ts";
import type { KernelInspectAPI } from "../types.ts";
import type { KernelInspectSnapshot } from "./protocol.ts";

export interface RunnerCall {
  trace: TraceContext;
  inspect?: KernelInspectSnapshot;
}

const callStorage = new AsyncLocalStorage<RunnerCall>();

export function currentCall(): RunnerCall | undefined {
  return callStorage.getStore();
}

export function runCall<T>(call: RunnerCall, fn: () => T): T {
  return callStorage.run(call, () => runInTrace(call.trace, fn));
}

// A dev view's `kernel`: bound once, at instantiate, and reading the snapshot
// of whichever call is running it.
export const callInspect: KernelInspectAPI = {
  listRoutes: () => snapshot().routes,
  listHandlers: () => snapshot().handlers,
  listFunctions: () => snapshot().functions,
  listConfigs: () => snapshot().configs,
  listSchemas: () => Promise.resolve(snapshot().schemas),
  listTypes: () => snapshot().types,
  listDevViews: () => snapshot().devViews,
  getAssetContent: (name) =>
    Object.hasOwn(snapshot().assets, name)
      ? snapshot().assets[name] ?? null
      : null,
  getDevViewSource: (name) =>
    Object.hasOwn(snapshot().devViewSources, name)
      ? snapshot().devViewSources[name] ?? null
      : null,
};

function snapshot(): KernelInspectSnapshot {
  const inspect = currentCall()?.inspect;
  if (!inspect) {
    throw new Error("`kernel` is only readable while a dev view is running");
  }
  return inspect;
}
