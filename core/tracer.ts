import { AsyncLocalStorage } from "node:async_hooks";
import type {
  DbInterface,
  FunctionRegistry,
  TemplateRegistry,
} from "./types.ts";
import { LogBuffer } from "./registries.ts";

export interface TraceEvent {
  id: number;
  timestamp: number;
  type:
    | "exit"
    | "error"
    | "state-read"
    | "state-write"
    | "state-delete"
    | "db-query"
    | "db-execute"
    | "template-read"
    | "function-call";
  entityType: string;
  entityName: string;
  data: Record<string, unknown>;
}

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

class TraceContext {
  readonly events: TraceEvent[] = [];
  private nextId = 1;

  exit(
    entityType: string,
    entityName: string,
    returnValue: unknown,
    durationMs: number,
  ): void {
    this.push("exit", entityType, entityName, {
      returnValue: summarize(returnValue),
      durationMs: round2(durationMs),
    });
  }

  error(entityType: string, entityName: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.push("error", entityType, entityName, { error: message });
  }

  dbQuery(
    sql: string,
    params: unknown[] | undefined,
    rowCount: number,
    durationMs: number,
  ): void {
    this.push("db-query", "schema", extractTable(sql), {
      sql,
      params,
      rowCount,
      durationMs: round2(durationMs),
    });
  }

  dbExecute(
    sql: string,
    params: unknown[] | undefined,
    changes: number,
    durationMs: number,
  ): void {
    this.push("db-execute", "schema", extractTable(sql), {
      sql,
      params,
      changes,
      durationMs: round2(durationMs),
    });
  }

  templateRead(name: string): void {
    this.push("template-read", "template", name, {});
  }

  functionCall(name: string, args: unknown[]): void {
    this.push("function-call", "function", name, { args: summarizeArgs(args) });
  }

  private push(
    type: TraceEvent["type"],
    entityType: string,
    entityName: string,
    data: Record<string, unknown>,
  ): void {
    this.events.push({
      id: this.nextId++,
      timestamp: performance.now(),
      type,
      entityType,
      entityName,
      data,
    });
  }
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

function ctx(): TraceContext | undefined {
  return traceStorage.getStore();
}

import { getKernelSettings } from "./config.ts";
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
      const result = await traceStorage.run(traceCtx, fn);
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

// --- Instrumented dep wrappers (check AsyncLocalStorage for active context) ---

export function tracedDb(db: DbInterface): DbInterface {
  return {
    async query(
      sql: string,
      params?: unknown[],
    ): Promise<Record<string, unknown>[]> {
      const start = performance.now();
      try {
        const rows = await db.query(sql, params);
        ctx()?.dbQuery(sql, params, rows.length, performance.now() - start);
        return rows;
      } catch (err) {
        ctx()?.dbQuery(sql, params, 0, performance.now() - start);
        throw new Error(
          `SQL query failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    async execute(
      sql: string,
      params?: unknown[],
    ): Promise<{ changes: number }> {
      const start = performance.now();
      try {
        const result = await db.execute(sql, params);
        ctx()?.dbExecute(
          sql,
          params,
          result.changes,
          performance.now() - start,
        );
        return result;
      } catch (err) {
        ctx()?.dbExecute(sql, params, 0, performance.now() - start);
        throw new Error(
          `SQL execute failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  };
}

const ASSET_URL_RE = /(\/_assets\/)([^"'?\s#]+)(\?v=[^"'\s#]*)?/g;

export function tracedTemplates(
  templates: TemplateRegistry,
  assetVersion?: (name: string) => string | undefined,
): TemplateRegistry {
  return {
    get(name: string): string | undefined {
      ctx()?.templateRead(name);
      const content = templates.get(name);
      if (!content || !assetVersion) return content;
      return content.replace(
        ASSET_URL_RE,
        (match, prefix: string, assetName: string) => {
          const v = assetVersion(assetName);
          return v ? `${prefix}${assetName}?v=${v}` : match;
        },
      );
    },
  };
}

export function tracedFunctions(functions: FunctionRegistry): FunctionRegistry {
  return {
    get(name: string) {
      return functions.get(name);
    },
    call(name: string, ...args: unknown[]): unknown {
      const c = ctx();
      c?.functionCall(name, args);
      const start = performance.now();
      try {
        const result = functions.call(name, ...args);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (r) => {
              c?.exit("function", name, r, performance.now() - start);
              return r;
            },
            (e) => {
              c?.error("function", name, e);
              throw e;
            },
          );
        }
        c?.exit("function", name, result, performance.now() - start);
        return result;
      } catch (e) {
        c?.error("function", name, e);
        throw e;
      }
    },
  };
}

// --- Helpers ---

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function summarize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 200 ? value.slice(0, 200) + "…" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === "object") {
    try {
      const s = JSON.stringify(value);
      return s.length > 200 ? s.slice(0, 200) + "…" : s;
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

function summarizeArgs(args: unknown[]): unknown[] {
  return args.map(summarize);
}

const TABLE_RE = /\b(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+[`"']?(\w+)/i;

function extractTable(sql: string): string {
  return (sql.match(TABLE_RE)?.[1] ?? "unknown").toLowerCase();
}
