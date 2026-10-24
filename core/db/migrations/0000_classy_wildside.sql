CREATE TABLE "_genie_changelog" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"key" text NOT NULL,
	"action" text NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb,
	"context" jsonb,
	"created_at" text NOT NULL,
	"undoable" boolean DEFAULT true NOT NULL,
	"turn_id" text,
	"changeset_id" text
);
--> statement-breakpoint
CREATE TABLE "_genie_changesets" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planning' NOT NULL,
	"plan" jsonb,
	"plan_message_ids" jsonb,
	"approval_message_id" integer,
	"work_message_ids" jsonb,
	"tool_calls" jsonb,
	"reasoning" jsonb,
	"token_usage" jsonb,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "_genie_env_vars" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text,
	"description" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "_genie_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"turn_id" text,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "_genie_meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "_genie_schemas" (
	"table_name" text PRIMARY KEY NOT NULL,
	"columns" jsonb NOT NULL,
	"sql_source" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "_genie_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"started_at" text NOT NULL,
	"ended_at" text,
	"summary" text,
	"focus" text,
	"metadata" text,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "_genie_skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"prompt" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "_genie_skills_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "_genie_turn_usage" (
	"turn_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"model" text NOT NULL,
	"started_at" text NOT NULL,
	"ended_at" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"tool_calls_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "_genie_messages" ADD CONSTRAINT "_genie_messages_session_id__genie_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."_genie_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "_genie_turn_usage" ADD CONSTRAINT "_genie_turn_usage_session_id__genie_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."_genie_sessions"("id") ON DELETE cascade ON UPDATE no action;