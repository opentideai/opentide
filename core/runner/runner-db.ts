// The runner's `db`: the same object user code gets in-process
// (core/handler-db.ts), with drizzle on pg-proxy and every statement sent to
// the kernel's db.exec (./db-service.ts). Nothing here opens a database, and
// the runner's permissions wouldn't let it.
//
// Differences from in-process that user code can see:
// - A failed statement's error keeps its name, message and the driver's fields
//   (`code`, `constraint`, ...), but not its class.
// - `db.transaction` doesn't exist in either; pg-proxy would throw on it.
//   A raw BEGIN through db.execute interleaves with other requests exactly as
//   it does in-process.

import { drizzle } from "drizzle-orm/pg-proxy";
import type { DynamicSchemaRegistry } from "../db/dynamic-schema.ts";
import { buildHandlerDb, type HandlerDb } from "../handler-db.ts";
import { RUNNER_REQUEST_TIMEOUT_MS } from "../config.ts";
import type { RpcPeer } from "./peer.ts";
import {
  DB_EXEC_KINDS,
  type DbErrorShape,
  type DbExecOutcome,
  type DbExecRequest,
  RUNNER_METHODS,
} from "./protocol.ts";

// Runs one statement on the kernel. Resolves to its value or throws the error
// user code would have caught.
export type DbExec = (request: DbExecRequest) => Promise<unknown>;

export function buildRunnerDb(
  exec: DbExec,
  schemas: DynamicSchemaRegistry,
): HandlerDb {
  const proxy = drizzle(async (sql, params, method) => {
    const kind = method === "all"
      ? DB_EXEC_KINDS.drizzleRows
      : DB_EXEC_KINDS.drizzleResult;
    // pg-proxy hands back `rows` as the statement's result, so in result mode
    // this is the driver's whole result, as in-process drizzle returns it.
    return { rows: await exec({ kind, sql, params }) as unknown[] };
  });
  const raw = {
    query: (sql: string, params?: unknown[]) =>
      exec({ kind: DB_EXEC_KINDS.query, sql, params }) as Promise<
        Record<string, unknown>[]
      >,
    execute: (sql: string, params?: unknown[]) =>
      exec({ kind: DB_EXEC_KINDS.execute, sql, params }) as Promise<
        { changes: number }
      >,
  };
  return buildHandlerDb(raw, proxy, schemas);
}

// db.exec over the runner's connection. `requestId` says which app request is
// running, so the kernel files the statement under that trace.
export function rpcDbExec(
  peer: RpcPeer,
  requestId: () => string | undefined = () => undefined,
): DbExec {
  return async (request) => {
    const answer = await peer.request<DbExecOutcome>(
      RUNNER_METHODS.dbExec,
      { ...request, requestId: requestId() },
      RUNNER_REQUEST_TIMEOUT_MS,
    );
    if (!answer.ok) throw new Error(`db.exec: ${answer.error.message}`);
    if (!answer.data.ok) throw rebuildError(answer.data.error);
    return answer.data.value;
  };
}

function rebuildError(shape: DbErrorShape): Error {
  const err = new Error(shape.message);
  Object.assign(err, shape.fields);
  err.name = shape.name;
  return err;
}
