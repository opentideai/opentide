import {
  and,
  asc,
  avg,
  between,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  max,
  min,
  ne,
  not,
  notExists,
  notIlike,
  notInArray,
  notLike,
  or,
  sql,
  sum,
} from "drizzle-orm";
import type { DbInterface } from "./types.ts";
import type { DrizzleDb } from "./db/factory.ts";
import type { DynamicSchemaRegistry } from "./db/dynamic-schema.ts";

// deno-lint-ignore no-explicit-any
type HandlerDb = DbInterface & Record<string, any>;

export function buildHandlerDb(
  traced: DbInterface,
  drizzle: DrizzleDb,
  schemas: DynamicSchemaRegistry,
): HandlerDb {
  return {
    query: traced.query,
    execute: traced.execute,

    select: (...args: unknown[]) =>
      (drizzle.select as CallableFunction)(...args),
    insert: (table: unknown) => (drizzle.insert as CallableFunction)(table),
    update: (table: unknown) => (drizzle.update as CallableFunction)(table),
    delete: (table: unknown) => (drizzle.delete as CallableFunction)(table),

    get tables() {
      return schemas.all();
    },

    eq,
    ne,
    gt,
    gte,
    lt,
    lte,
    and,
    or,
    not,
    asc,
    desc,
    like,
    ilike,
    notLike,
    notIlike,
    inArray,
    notInArray,
    isNull,
    isNotNull,
    between,
    count,
    sum,
    avg,
    min,
    max,
    sql,
    exists,
    notExists,
  };
}
