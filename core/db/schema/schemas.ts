import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import type { ColumnDef } from "../../types.ts";

export const genieSchemasTable = pgTable("_genie_schemas", {
  tableName: text("table_name").primaryKey(),
  columns: jsonb("columns").$type<ColumnDef[]>().notNull(),
  sqlSource: text("sql_source").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  module: text("module"),
});
