CREATE TABLE "_genie_model_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"turn_id" text,
	"audit_result_id" text,
	"changeset_id" text,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"role" text NOT NULL,
	"caller" text NOT NULL,
	"started_at" text NOT NULL,
	"ended_at" text NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"tool_calls_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" real,
	"pricing_status" text NOT NULL,
	"pricing_provider" text,
	"pricing_model" text,
	"pricing_verified_at" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "_genie_model_usage" ADD CONSTRAINT "_genie_model_usage_session_id__genie_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."_genie_sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "model_usage_session_id_idx" ON "_genie_model_usage" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX "model_usage_turn_id_idx" ON "_genie_model_usage" USING btree ("turn_id");
--> statement-breakpoint
CREATE INDEX "model_usage_started_at_idx" ON "_genie_model_usage" USING btree ("started_at");
