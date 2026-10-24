CREATE TABLE "_genie_schema_migrations" (
	"id" serial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"version" integer NOT NULL,
	"sql" text NOT NULL,
	"reverse_sql" text,
	"reversible" boolean DEFAULT true NOT NULL,
	"columns_before" jsonb NOT NULL,
	"columns_after" jsonb NOT NULL,
	"applied_at" text NOT NULL,
	"rolled_back_at" text,
	"turn_id" text
);
