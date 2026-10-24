import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
} from "drizzle-orm/pg-core";
import type { ColumnDef } from "../../types.ts";

export const genieSchemaMigrationsTable = pgTable("_genie_schema_migrations", {
  id: serial("id").primaryKey(),
  tableName: text("table_name").notNull(),
  version: integer("version").notNull(),
  sql: text("sql").notNull(),
  reverseSql: text("reverse_sql"),
  reversible: boolean("reversible").notNull().default(true),
  columnsBefore: jsonb("columns_before").$type<ColumnDef[]>().notNull(),
  columnsAfter: jsonb("columns_after").$type<ColumnDef[]>().notNull(),
  appliedAt: text("applied_at").notNull(),
  rolledBackAt: text("rolled_back_at"),
  turnId: text("turn_id"),
  changesetId: text("changeset_id"),
});
