CREATE TABLE "_genie_audit_results" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"status" text NOT NULL,
	"started_at" text NOT NULL,
	"completed_at" text,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text NOT NULL,
	"score" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"duration_ms" integer,
	"model" text,
	"input_tokens" integer DEFAULT 0,
	"output_tokens" integer DEFAULT 0,
	"cache_creation_input_tokens" integer DEFAULT 0,
	"cache_read_input_tokens" integer DEFAULT 0,
	"cost_usd" real DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX "audit_results_category_idx" ON "_genie_audit_results" USING btree ("category");--> statement-breakpoint
CREATE INDEX "audit_results_category_started_idx" ON "_genie_audit_results" USING btree ("category","started_at");