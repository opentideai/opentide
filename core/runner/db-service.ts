// The kernel's side of the runner's database: answers db.exec. The runner has
// no database of its own, only drizzle on pg-proxy (./runner-db.ts), so every
// statement user code makes arrives here and runs on the kernel's connection.
//
// Raw db.query/db.execute run as they are: the runner traces them itself, so
// a call's events all come from one clock. Drizzle statements run through the
// kernel's own drizzle session, with its parsers, so the runner's drizzle maps
// exactly the rows the in-process one would.

import type { Database } from "../db.ts";
import type { RequestHandler } from "./peer.ts";
import {
  DB_EXEC_KINDS,
  type DbErrorShape,
  type DbExecOutcome,
  type DbExecRequest,
  RUNNER_ERROR_CODES,
} from "./protocol.ts";

export function dbExecHandler(db: Database): RequestHandler {
  return async (params) => {
    const request = parseDbExecRequest(params);
    if (!request) {
      return {
        ok: false,
        error: {
          code: RUNNER_ERROR_CODES.invalidParams,
          message: "db.exec needs { kind, sql, params? }",
        },
      };
    }
    return { ok: true, data: await runStatement(request, db) };
  };
}

async function runStatement(
  request: DbExecRequest,
  db: Database,
): Promise<DbExecOutcome> {
  const { sql, params } = request;
  try {
    switch (request.kind) {
      case DB_EXEC_KINDS.query:
        return { ok: true, value: await db.query(sql, params) };
      case DB_EXEC_KINDS.execute:
        return { ok: true, value: await db.execute(sql, params) };
      case DB_EXEC_KINDS.drizzleRows:
        return { ok: true, value: await drizzleStatement(db, request, true) };
      case DB_EXEC_KINDS.drizzleResult:
        return { ok: true, value: await drizzleStatement(db, request, false) };
    }
  } catch (err) {
    return { ok: false, error: describeDbError(request, err) };
  }
}

// In rows mode the identity mapper makes the session return the driver's
// positional rows untouched; the runner's drizzle maps them by column. In
// result mode, no fields and no mapper, so the session returns what the driver
// does. Either way the session's own parsers apply.
function drizzleStatement(
  db: Database,
  request: DbExecRequest,
  rows: boolean,
): Promise<unknown> {
  const query = { sql: request.sql, params: request.params ?? [] };
  const prepared = rows
    ? db.drizzle._.session.prepareQuery(
      query,
      undefined,
      undefined,
      true,
      (raw: unknown[][]) => raw,
    )
    : db.drizzle._.session.prepareQuery(query, undefined, undefined, false);
  return prepared.execute();
}

// A drizzle statement fails as DrizzleQueryError around the driver's error.
// The runner's pg-proxy wraps whatever it's given the same way, so it gets the
// driver's error and the wrapping happens once, on its side.
function describeDbError(request: DbExecRequest, err: unknown): DbErrorShape {
  const isDrizzle = request.kind === DB_EXEC_KINDS.drizzleRows ||
    request.kind === DB_EXEC_KINDS.drizzleResult;
  const cause = isDrizzle && err instanceof Error && err.cause !== undefined
    ? err.cause
    : err;
  if (!(cause instanceof Error)) {
    return { name: "Error", message: String(cause), fields: {} };
  }
  return {
    name: cause.name,
    message: cause.message,
    fields: errorFields(cause),
  };
}

function errorFields(err: Error): DbErrorShape["fields"] {
  const fields: DbErrorShape["fields"] = {};
  for (const [key, value] of Object.entries(err)) {
    if (
      typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean"
    ) {
      fields[key] = value;
    }
  }
  return fields;
}

function parseDbExecRequest(params: unknown): DbExecRequest | null {
  if (typeof params !== "object" || params === null) return null;
  const p = params as Record<string, unknown>;
  const kinds: readonly unknown[] = Object.values(DB_EXEC_KINDS);
  if (!kinds.includes(p.kind) || typeof p.sql !== "string") return null;
  if (p.params !== undefined && !Array.isArray(p.params)) return null;
  return {
    kind: p.kind as DbExecRequest["kind"],
    sql: p.sql,
    params: p.params as unknown[] | undefined,
  };
}
