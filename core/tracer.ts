// The kernel's request traces: one per app request, kept in a ring buffer
// for the IDE. What records into them lives in ./trace-context.ts, which the
// runner loads too.

import { getKernelSettings } from "./config.ts";
import { LogBuffer } from "./registries.ts";
import {
  round2,
  runInTrace,
  TraceContext,
  type TraceEvent,
} from "./trace-context.ts";

export interface RequestTrace {
  requestId: string;
  method: string;
  path: string;
  startedAt: number;
  endedAt: number | null;
  events: TraceEvent[];
  status: number | null;
  durationMs: number | null;
}

const DEFAULT_MAX_TRACES = getKernelSettings().maxTraces;

export class Tracer {
  private traces: LogBuffer<RequestTrace>;
  private active = new Map<string, RequestTrace>();

  constructor(maxTraces = DEFAULT_MAX_TRACES) {
    this.traces = new LogBuffer<RequestTrace>(maxTraces);
  }

  async run<T>(
    requestId: string,
    method: string,
    path: string,
    fn: () => T | Promise<T>,
  ): Promise<{ result: T; trace: RequestTrace }> {
    const traceCtx = new TraceContext();
    const trace: RequestTrace = {
      requestId,
      method,
      path,
      startedAt: performance.now(),
      endedAt: null,
      events: traceCtx.events,
      status: null,
      durationMs: null,
    };
    this.active.set(requestId, trace);

    try {
      const result = await runInTrace(traceCtx, fn);
      return { result, trace };
    } finally {
      trace.endedAt = performance.now();
      trace.durationMs = round2(trace.endedAt - trace.startedAt);
      this.active.delete(requestId);
      this.traces.push(trace);
    }
  }

  getTrace(requestId: string): RequestTrace | undefined {
    return this.active.get(requestId) ??
      this.traces.recent(this.traces.size).find((t) =>
        t.requestId === requestId
      );
  }

  getRecentTraces(limit = 20): RequestTrace[] {
    return this.traces.recent(limit);
  }

  clear(): void {
    this.traces.clear();
    this.active.clear();
  }
}
