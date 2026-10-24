import { boolean, pgTable, serial, text } from "drizzle-orm/pg-core";

export const genieSkillsTable = pgTable("_genie_skills", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  prompt: text("prompt").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
