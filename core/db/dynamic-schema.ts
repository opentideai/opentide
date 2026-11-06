import {
  bigint,
  boolean,
  char,
  date,
  doublePrecision,
  integer,
  json,
  jsonb,
  numeric,
  pgTable,
  real,
  serial,
  smallint,
  text,
  time,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import type { ColumnDef } from "../types.ts";

// deno-lint-ignore no-explicit-any
type AnyTable = ReturnType<typeof pgTable<any, any>>;
// deno-lint-ignore no-explicit-any
type ColumnFactory = (name: string) => any;

const TYPE_MAP: Record<string, ColumnFactory> = {
  "serial": (n) => serial(n),
  "integer": (n) => integer(n),
  "int": (n) => integer(n),
  "int4": (n) => integer(n),
  "bigint": (n) => bigint(n, { mode: "number" }),
  "int8": (n) => bigint(n, { mode: "number" }),
  "bigserial": (n) => bigint(n, { mode: "number" }),
  "smallint": (n) => smallint(n),
  "int2": (n) => smallint(n),
  "text": (n) => text(n),
  "character varying": (n) => varchar(n),
  "varchar": (n) => varchar(n),
  "character": (n) => char(n),
  "char": (n) => char(n),
  "boolean": (n) => boolean(n),
  "bool": (n) => boolean(n),
  "real": (n) => real(n),
  "float4": (n) => real(n),
  "double precision": (n) => doublePrecision(n),
  "float8": (n) => doublePrecision(n),
  "numeric": (n) => numeric(n),
  "decimal": (n) => numeric(n),
  "timestamp without time zone": (n) => timestamp(n),
  "timestamp with time zone": (n) => timestamp(n, { withTimezone: true }),
  "timestamptz": (n) => timestamp(n, { withTimezone: true }),
  "date": (n) => date(n),
  "time without time zone": (n) => time(n),
  "time with time zone": (n) => time(n, { withTimezone: true }),
  "json": (n) => json(n),
  "jsonb": (n) => jsonb(n),
  "uuid": (n) => uuid(n),
  "user-defined": (n) => text(n),
};

// deno-lint-ignore no-explicit-any
function buildColumn(col: ColumnDef): any {
  const typeLower = col.type.toLowerCase();
  const factory = TYPE_MAP[typeLower];
  let builder = factory ? factory(col.name) : text(col.name);

  if (col.primaryKey) {
    builder = builder.primaryKey();
  }
  if (!col.nullable && !col.primaryKey) {
    builder = builder.notNull();
  }

  return builder;
}

export function buildDrizzleTable(
  tableName: string,
  columns: ColumnDef[],
): AnyTable {
  // deno-lint-ignore no-explicit-any
  const columnDefs: Record<string, any> = {};
  for (const col of columns) {
    columnDefs[col.name] = buildColumn(col);
  }
  return pgTable(tableName, columnDefs);
}

export interface SchemaDefinition {
  tableName: string;
  columns: readonly ColumnDef[];
}

export class DynamicSchemaRegistry {
  private tables = new Map<string, AnyTable>();
  // What each table was built from, so the runner can build the same one.
  // A copy, replaced on every register, never edited.
  private definitions = new Map<string, SchemaDefinition>();

  register(tableName: string, columns: ColumnDef[]): AnyTable {
    const table = buildDrizzleTable(tableName, columns);
    this.tables.set(tableName, table);
    this.definitions.set(tableName, {
      tableName,
      columns: structuredClone(columns),
    });
    return table;
  }

  remove(tableName: string): void {
    this.tables.delete(tableName);
    this.definitions.delete(tableName);
  }

  get(tableName: string): AnyTable | undefined {
    return this.tables.get(tableName);
  }

  all(): Record<string, AnyTable> {
    const result: Record<string, AnyTable> = {};
    for (const [name, table] of this.tables) {
      result[name] = table;
    }
    return result;
  }

  listDefinitions(): SchemaDefinition[] {
    return [...this.definitions.values()];
  }

  clear(): void {
    this.tables.clear();
    this.definitions.clear();
  }
}
