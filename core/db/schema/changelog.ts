import {
  boolean,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
} from "drizzle-orm/pg-core";

export const genieChangelogTable = pgTable("_genie_changelog", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  key: text("key").notNull(),
  action: text("action").notNull(),
  beforeSnapshot: jsonb("before_snapshot"),
  afterSnapshot: jsonb("after_snapshot"),
  context: jsonb("context"),
  createdAt: text("created_at").notNull(),
  undoable: boolean("undoable").notNull().default(true),
  turnId: text("turn_id"),
  changesetId: text("changeset_id"),
  rationale: text("rationale"),
  implementation: text("implementation"),
  workMessageId: integer("work_message_id"),
  actorUserId: text("actor_user_id"),
});

export const genieMetaTable = pgTable("_genie_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
